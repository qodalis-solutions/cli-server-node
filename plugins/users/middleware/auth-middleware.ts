import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthAdapter } from '../models';
import { AuthService, AuthContext } from '../services/auth-service';
import { asyncHandler, forbidden, unauthorized } from '../errors';
import { ADMIN_GROUP, hasPermission, inGroup } from '../permissions';

declare global {
    namespace Express {
        interface Request {
            /** Set by the users plugin auth middleware. */
            qcliAuth?: AuthContext;
        }
    }
}

/** Extracts the bearer token from the Authorization header. */
export function getBearerToken(req: Request): string | undefined {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
        return undefined;
    }
    const token = header.slice(7).trim();
    return token || undefined;
}

/**
 * Authenticates the request (bearer token, or the host's auth adapter) and
 * attaches the live user and effective permissions as `req.qcliAuth`.
 */
export function createAuthMiddleware(authService: AuthService, authAdapter?: AuthAdapter): RequestHandler {
    return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
        if (authAdapter) {
            const result = authAdapter(req);
            if (!result || !result.user) {
                throw unauthorized();
            }
            const { user, isAdmin } = result;
            if (user.disabled) {
                throw unauthorized('account disabled');
            }
            const groups = [...(user.groups ?? [])];
            if (isAdmin && !inGroup(groups, ADMIN_GROUP)) {
                groups.push(ADMIN_GROUP);
            }
            const liveUser = { ...user, groups };
            req.qcliAuth = { user: liveUser, permissions: await authService.getEffectivePermissions(liveUser) };
            next();
            return;
        }

        const token = getBearerToken(req);
        if (!token) {
            throw unauthorized();
        }
        req.qcliAuth = await authService.authenticateToken(token);
        next();
    });
}

/** The authenticated context; fails closed (401) if the middleware did not run. */
export function getAuth(req: Request): AuthContext {
    if (!req.qcliAuth) {
        throw unauthorized();
    }
    return req.qcliAuth;
}

export function can(req: Request, permission: string): boolean {
    return hasPermission(req.qcliAuth?.permissions, permission);
}

/** Middleware requiring all the given permissions (403 otherwise). */
export function requirePermission(...permissions: string[]): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
        const auth = req.qcliAuth;
        if (!auth) {
            next(unauthorized());
            return;
        }
        const missing = permissions.filter((p) => !hasPermission(auth.permissions, p));
        if (missing.length > 0) {
            next(forbidden(`forbidden: missing permission ${missing.join(', ')}`));
            return;
        }
        next();
    };
}
