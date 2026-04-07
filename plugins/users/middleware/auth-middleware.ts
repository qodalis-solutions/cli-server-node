import { Request, Response, NextFunction } from 'express';
import { ICliSessionStore } from '../stores/interfaces';
import { Session } from '../models';

// Extend Express Request to include the session
declare global {
    namespace Express {
        interface Request {
            session?: Session;
        }
    }
}

export function createAuthMiddleware(sessionStore: ICliSessionStore) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }

        const token = authHeader.slice(7);
        const session = await sessionStore.getSession(token);
        if (!session) {
            res.status(401).json({ error: 'Invalid or expired token' });
            return;
        }

        await sessionStore.updateLastActivity(token);
        req.session = session;
        next();
    };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.session?.user?.groups?.includes('admin')) {
        res.status(403).json({ error: 'Forbidden: admin access required' });
        return;
    }
    next();
}
