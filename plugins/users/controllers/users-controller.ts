import { Router, Request, Response } from 'express';
import { AuthService, toUserJson } from '../services/auth-service';
import { DirectoryService, bodyOf, callerOf, optionalBoolean } from '../services/directory-service';
import { can, getAuth, requirePermission, PASSWORD_CHANGE_REQUIRED } from '../middleware/auth-middleware';
import { asyncHandler, badRequest, forbidden, HttpError } from '../errors';
import { UsersPermissions as P } from '../permissions';
import { User } from '../models';

export interface UsersControllerOptions {
    /** When true, password endpoints return 501 (the host app owns credentials). */
    externalAuth?: boolean;
    /** Per-IP attempt limiter for verify-password and self password change (throws 429). */
    limitAttempt?: (req: Request) => void;
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
        const user = await directory.createUser(bodyOf(req), callerOf(auth), options.externalAuth);
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
        const updated = await directory.updateUser(target, body, callerOf(auth));
        res.json(toUserJson(updated));
    }));

    // DELETE /:idOrName — users:delete
    router.delete('/:idOrName', requirePermission(P.UsersDelete), asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const target = await directory.getUserOr404(req.params.idOrName);
        await directory.deleteUser(target, callerOf(auth));
        res.status(204).end();
    }));

    // PUT /:idOrName/password — self (with currentPassword) or users:update
    router.put('/:idOrName/password', asyncHandler(async (req: Request, res: Response) => {
        if (options.externalAuth) throw notAvailable();
        const auth = getAuth(req);
        if (auth.apiToken) {
            throw forbidden('forbidden: API tokens cannot change passwords');
        }
        const caller = callerOf(auth);
        const body = bodyOf(req);
        const { target, privileged, isSelf } = await resolveSelfOr(req, P.UsersUpdate);
        if (auth.user.mustChangePassword && !isSelf) {
            throw forbidden(PASSWORD_CHANGE_REQUIRED);
        }
        const temporary = optionalBoolean(body, 'temporary');
        const password = body.password;
        authService.validatePassword(password);

        if (isSelf) {
            options.limitAttempt?.(req);
            const current = body.currentPassword;
            if (!privileged && (typeof current !== 'string' || current.length === 0)) {
                throw badRequest('currentPassword is required');
            }
            if (typeof current === 'string' && current.length > 0) {
                const valid = await authService.verifyPasswordWithLockout(target, current, {
                    actor: caller.name,
                    actorId: caller.id,
                    remoteAddress: req.ip,
                    details: 'Wrong current password',
                });
                if (!valid) {
                    throw forbidden('current password is incorrect');
                }
            }
        } else {
            await directory.assertCanActOn(caller, target);
        }

        await authService.setPassword(target.id, password);
        // Self change clears the flag; an admin reset makes the password temporary unless `temporary: false`.
        const mustChangePassword = isSelf ? false : temporary !== false;
        await directory.setMustChangePassword(target, mustChangePassword);
        await authService.audit({ event: 'password_changed', username: target.name, userId: target.id, actor: caller.name, actorId: caller.id });

        if (isSelf) {
            await authService.revokeUserSessions(target.id, 'password changed', {
                actor: caller.name,
                actorId: caller.id,
                exceptSessionId: auth.session?.id,
                userName: target.name,
            });
        } else {
            authService.clearLockout(target.id);
            await authService.revokeUserSessions(target.id, 'password changed', {
                actor: caller.name,
                actorId: caller.id,
                userName: target.name,
            });
        }
        res.status(204).end();
    }));

    // POST /:idOrName/verify-password — self or users:update → { valid }
    router.post('/:idOrName/verify-password', asyncHandler(async (req: Request, res: Response) => {
        if (options.externalAuth) throw notAvailable();
        const auth = getAuth(req);
        const caller = callerOf(auth);
        const body = bodyOf(req);
        const { target, isSelf } = await resolveSelfOr(req, P.UsersUpdate);
        if (!isSelf) {
            await directory.assertCanActOn(caller, target);
        }
        const password = body.password;
        if (typeof password !== 'string' || password.length === 0) {
            throw badRequest('password is required');
        }
        options.limitAttempt?.(req);
        const valid = await authService.verifyPasswordWithLockout(target, password, {
            actor: caller.name,
            actorId: caller.id,
            remoteAddress: req.ip,
            details: 'Password verification failed',
        });
        res.json({ valid });
    }));

    return router;
}
