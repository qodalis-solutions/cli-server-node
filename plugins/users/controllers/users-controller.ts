import { Router, Request, Response } from 'express';
import { AuthService, toUserJson } from '../services/auth-service';
import { DirectoryService, bodyOf } from '../services/directory-service';
import { can, getAuth, requirePermission } from '../middleware/auth-middleware';
import { asyncHandler, badRequest, forbidden, HttpError } from '../errors';
import { UsersPermissions as P } from '../permissions';
import { User } from '../models';

export interface UsersControllerOptions {
    /** When true, password endpoints return 501 (the host app owns credentials). */
    externalAuth?: boolean;
}

const notAvailable = () => new HttpError(501, 'Authentication is managed by the host application');

function parseNonNegativeInt(value: unknown, field: string): number | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw badRequest(`${field} must be a non-negative integer`);
    }
    return parseInt(value, 10);
}

/**
 * `/users` resource. Expects the auth middleware to have run.
 */
export function createUsersController(
    authService: AuthService,
    directory: DirectoryService,
    options: UsersControllerOptions = {},
): Router {
    const router = Router();

    /** Resolves the target user for "permission or self" endpoints. Non-privileged callers get 403 for anyone else (including unknown users). */
    const resolveSelfOr = async (req: Request, permission: string): Promise<{ target: User; privileged: boolean; isSelf: boolean }> => {
        const auth = getAuth(req);
        const privileged = can(req, permission);
        if (privileged) {
            const target = await directory.getUserOr404(req.params.idOrName);
            return { target, privileged, isSelf: target.id === auth.user.id };
        }
        const target = await directory.getUserOr404(req.params.idOrName).catch(() => undefined);
        if (!target || target.id !== auth.user.id) {
            throw forbidden(`forbidden: missing permission ${permission}`);
        }
        return { target, privileged, isSelf: true };
    };

    // GET / — list users (?query=&skip=&take=)
    router.get('/', requirePermission(P.UsersRead), asyncHandler(async (req: Request, res: Response) => {
        const query = typeof req.query.query === 'string' ? req.query.query : undefined;
        const skip = parseNonNegativeInt(req.query.skip, 'skip') ?? 0;
        const take = parseNonNegativeInt(req.query.take, 'take');
        const users = await directory.listUsers(query, skip, take);
        res.json(users.map(toUserJson));
    }));

    // POST / — create user
    router.post('/', requirePermission(P.UsersCreate), asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const user = await directory.createUser(bodyOf(req), auth.user.name, options.externalAuth);
        res.status(201).json(toUserJson(user));
    }));

    // GET /:idOrName — users:read or self
    router.get('/:idOrName', asyncHandler(async (req: Request, res: Response) => {
        const { target } = await resolveSelfOr(req, P.UsersRead);
        res.json(toUserJson(target));
    }));

    // GET /:idOrName/permissions — users:read or self
    router.get('/:idOrName/permissions', asyncHandler(async (req: Request, res: Response) => {
        const { target } = await resolveSelfOr(req, P.UsersRead);
        const permissions = await authService.getEffectivePermissions(target);
        res.json({ userId: target.id, groups: [...target.groups], permissions });
    }));

    // PUT /:idOrName — users:update; self may change only email and data
    router.put('/:idOrName', asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const body = bodyOf(req);
        const { target, privileged } = await resolveSelfOr(req, P.UsersUpdate);
        if (!privileged) {
            const restricted = Object.keys(body).filter((k) => body[k] !== undefined && k !== 'email' && k !== 'data');
            if (restricted.length > 0) {
                throw forbidden(`forbidden: cannot change ${restricted.join(', ')} without ${P.UsersUpdate}`);
            }
        }
        const updated = await directory.updateUser(target, body, auth.user.name);
        res.json(toUserJson(updated));
    }));

    // DELETE /:idOrName — users:delete
    router.delete('/:idOrName', requirePermission(P.UsersDelete), asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const target = await directory.getUserOr404(req.params.idOrName);
        await directory.deleteUser(target, auth.user.id, auth.user.name);
        res.status(204).end();
    }));

    // PUT /:idOrName/password — self (with currentPassword) or users:update
    router.put('/:idOrName/password', asyncHandler(async (req: Request, res: Response) => {
        if (options.externalAuth) throw notAvailable();
        const auth = getAuth(req);
        const body = bodyOf(req);
        const { target, privileged, isSelf } = await resolveSelfOr(req, P.UsersUpdate);
        const password = body.password;
        authService.validatePassword(password);

        if (!privileged) {
            const current = body.currentPassword;
            if (typeof current !== 'string' || current.length === 0) {
                throw badRequest('currentPassword is required');
            }
            const valid = await authService.verifyPasswordWithLockout(target, current, {
                actor: auth.user.name,
                remoteAddress: req.ip,
                details: 'Wrong current password',
            });
            if (!valid) {
                throw forbidden('current password is incorrect');
            }
        }

        await authService.setPassword(target.id, password);
        await authService.audit({ event: 'password_changed', username: target.name, actor: auth.user.name });

        if (isSelf) {
            await authService.revokeUserSessions(target.id, 'password changed', {
                actor: auth.user.name,
                exceptSessionId: auth.session?.id,
                userName: target.name,
            });
        } else {
            await authService.revokeUserSessions(target.id, 'password changed', {
                actor: auth.user.name,
                userName: target.name,
            });
        }
        res.status(204).end();
    }));

    // POST /:idOrName/verify-password — self or users:update → { valid }
    router.post('/:idOrName/verify-password', asyncHandler(async (req: Request, res: Response) => {
        if (options.externalAuth) throw notAvailable();
        const auth = getAuth(req);
        const body = bodyOf(req);
        const { target } = await resolveSelfOr(req, P.UsersUpdate);
        const password = body.password;
        if (typeof password !== 'string' || password.length === 0) {
            throw badRequest('password is required');
        }
        const valid = await authService.verifyPasswordWithLockout(target, password, {
            actor: auth.user.name,
            remoteAddress: req.ip,
            details: 'Password verification failed',
        });
        res.json({ valid });
    }));

    return router;
}
