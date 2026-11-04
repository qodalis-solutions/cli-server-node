import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken, JwtPayload } from './jwt-service';
import { AdminAuthProvider, ADMIN_ACCESS_PERMISSION, errorMessage, errorStatus } from './auth-provider';

/**
 * Extended request interface with authenticated user info.
 */
export interface AuthenticatedRequest extends Request {
    user?: JwtPayload;
}

/**
 * Creates an Express middleware that validates JWT Bearer tokens.
 *
 * Skips authentication for the `/auth/login` path.
 *
 * @param secret JWT secret used to verify tokens.
 */
export function createAuthMiddleware(secret: string, provider?: AdminAuthProvider, isExternal?: () => boolean): RequestHandler {
    if (provider) {
        const sessions = createProviderAuthMiddleware(provider);
        const host = provider.authenticateRequest ? createHostSessionMiddleware(provider) : undefined;
        // External sign-in mode: the dashboard sends the host application's own bearer token.
        return (req, res, next) => (host && isExternal?.() ? host : sessions)(req, res, next);
    }
    return (req: Request, res: Response, next: NextFunction): void => {
        // Skip auth for login endpoint
        if (req.path === '/auth/login') {
            next();
            return;
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or invalid Authorization header' });
            return;
        }

        const token = authHeader.slice(7);

        try {
            const decoded = verifyToken(token, secret);
            (req as AuthenticatedRequest).user = decoded;
            next();
        } catch {
            res.status(401).json({ error: 'Invalid or expired token' });
        }
    };
}

/**
 * Auth middleware for external sign-in mode: the provider authenticates the request
 * as any other request from the host app (its external auth adapter), and the user
 * needs `admin:access`.
 */
function createHostSessionMiddleware(provider: AdminAuthProvider): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        provider.authenticateRequest!(req).then(
            (ctx) => {
                if (!provider.hasPermission(ctx, ADMIN_ACCESS_PERMISSION)) {
                    res.status(403).json({ error: `forbidden: missing permission ${ADMIN_ACCESS_PERMISSION}` });
                    return;
                }
                (req as AuthenticatedRequest).user = { username: ctx.userName, authenticatedAt: new Date().toISOString() };
                next();
            },
            (err) => {
                const status = (err as { status?: unknown })?.status;
                if (typeof status !== 'number') {
                    // not an auth error (e.g. a failing adapter): log it, never expose its message
                    console.error('[qcli-admin] authentication failed unexpectedly:', err);
                    res.status(500).json({ error: 'internal server error' });
                    return;
                }
                res.status(status).json({ error: errorMessage(err, 'Not authenticated') });
            },
        );
    };
}

/**
 * Auth middleware backed by the users plugin: a users session token with the
 * `admin:access` permission (and no pending password change).
 */
function createProviderAuthMiddleware(provider: AdminAuthProvider): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or invalid Authorization header' });
            return;
        }
        provider.authenticateToken(authHeader.slice(7)).then(
            (ctx) => {
                if (ctx.mustChangePassword) {
                    res.status(403).json({ error: 'password change required' });
                    return;
                }
                if (!provider.hasPermission(ctx, ADMIN_ACCESS_PERMISSION)) {
                    res.status(403).json({ error: `forbidden: missing permission ${ADMIN_ACCESS_PERMISSION}` });
                    return;
                }
                (req as AuthenticatedRequest).user = {
                    username: ctx.userName,
                    authenticatedAt: new Date(ctx.loginTime ?? Date.now()).toISOString(),
                };
                next();
            },
            (err) => {
                res.status(errorStatus(err)).json({ error: errorMessage(err, 'Invalid or expired token') });
            },
        );
    };
}
