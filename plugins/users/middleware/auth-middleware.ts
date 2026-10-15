import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthAdapter } from '../models';
import { AuthService, AuthContext } from '../services/auth-service';
import { asyncHandler, forbidden, unauthorized } from '../errors';
import { ADMIN_GROUP, hasPermission, inGroup } from '../permissions';
import { isOriginAllowed, isSameOrigin } from '../security';

declare global {
    namespace Express {
        interface Request {
            /** Set by the users plugin auth middleware. */
            qcliAuth?: AuthContext;
        }
    }
}

export const PASSWORD_CHANGE_REQUIRED = 'password change required';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
 * Authenticates requests: bearer token, or the host's auth adapter.
 * Enforces the CSRF rule: a state-changing request without a bearer token
 * (adapter/cookie mode) must come from an allowed `Origin` or from the
 * server's own origin (same-origin, e.g. the bundled admin dashboard).
 */
export class RequestAuthenticator {
    constructor(
        private readonly authService: AuthService,
        private readonly authAdapter: AuthAdapter | undefined,
        private readonly getAllowedOrigins: () => readonly string[] | undefined,
    ) {}

    async authenticate(req: Request): Promise<AuthContext> {
        const token = getBearerToken(req);
        let ctx: AuthContext;

        if (this.authAdapter) {
            const result = this.authAdapter(req);
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
            ctx = { user: liveUser, permissions: await this.authService.getEffectivePermissions(liveUser) };
        } else {
            if (!token) {
                throw unauthorized();
            }
            ctx = await this.authService.authenticateToken(token);
        }

        if (!token && STATE_CHANGING.has(req.method.toUpperCase())) {
            const origin = req.headers.origin;
            if (!isOriginAllowed(origin, this.getAllowedOrigins()) && !isSameOrigin(origin, req)) {
                throw forbidden('cross-site request rejected: origin not allowed');
            }
        }
        return ctx;
    }
}

/**
 * True for the only calls allowed while the user must change their password:
 * `GET/DELETE /sessions/current` and `PUT /users/{id}/password` (the controller
 * additionally checks that the target is the caller).
 */
function allowedDuringPasswordChange(req: Request): boolean {
    const base = req.baseUrl.toLowerCase().replace(/\/+$/, '');
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    const method = req.method.toUpperCase();
    if (base.endsWith('/sessions') && path === '/current' && (method === 'GET' || method === 'DELETE')) {
        return true;
    }
    if (base.endsWith('/users') && method === 'PUT' && /^\/[^/]+\/password$/.test(path)) {
        return true;
    }
    return false;
}

/**
 * Users-plugin route middleware: authenticates and attaches `req.qcliAuth`;
 * blocks everything but the password change while `mustChangePassword` is set.
 */
export function createAuthMiddleware(authenticator: RequestAuthenticator): RequestHandler {
    return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
        const ctx = await authenticator.authenticate(req);
        if (ctx.user.mustChangePassword && !allowedDuringPasswordChange(req)) {
            throw forbidden(PASSWORD_CHANGE_REQUIRED);
        }
        req.qcliAuth = ctx;
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
