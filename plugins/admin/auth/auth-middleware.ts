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
export function createAuthMiddleware(secret: string, provider?: AdminAuthProvider): RequestHandler {
    if (provider) {
        return createProviderAuthMiddleware(provider);
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
