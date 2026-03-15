import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken, JwtPayload } from './jwt-service';

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
 * @param secret Optional JWT secret override. If not provided, uses the default from jwt-service.
 */
export function createAuthMiddleware(secret?: string): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        // Skip auth for login endpoint
        if (req.path === '/auth/login' || req.path.endsWith('/auth/login')) {
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
