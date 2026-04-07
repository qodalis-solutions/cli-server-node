import { Request, Response, NextFunction } from 'express';
import { ICliSessionStore } from '../stores/interfaces';
import { Session, AuthAdapter } from '../models';

// Extend Express Request to include the session
declare global {
    namespace Express {
        interface Request {
            session?: Session;
        }
    }
}

export function createAuthMiddleware(sessionStore: ICliSessionStore, authAdapter?: AuthAdapter) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (authAdapter) {
            // External auth adapter path
            const result = authAdapter(req);
            if (!result) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }

            const { user, isAdmin } = result;

            // Ensure the user's groups reflect the isAdmin flag
            const groups = [...(user.groups ?? [])];
            if (isAdmin && !groups.includes('admin')) {
                groups.push('admin');
            }
            const sessionUser = { ...user, groups };

            // Create or reuse a lightweight session keyed by user id for audit trail
            const adapterTokenKey = `__adapter__${user.id}`;
            let session = await sessionStore.getSession(adapterTokenKey);
            if (!session) {
                session = await sessionStore.createSession(
                    user.id,
                    adapterTokenKey,
                    sessionUser,
                    {
                        remoteAddress: req.ip,
                        userAgent: req.headers['user-agent'],
                    },
                );
            } else {
                // Update the user snapshot in case groups/data changed
                session.user = sessionUser;
                await sessionStore.updateLastActivity(adapterTokenKey);
            }

            req.session = session;
            next();
            return;
        }

        // Standard Bearer-token path
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
