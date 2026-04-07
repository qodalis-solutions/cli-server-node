import { Router, Request, Response } from 'express';
import { AuthService } from '../services/auth-service';
import { ICliSessionStore } from '../stores/interfaces';
import { createAuthMiddleware } from '../middleware/auth-middleware';

export function createAuthController(
    authService: AuthService,
    sessionStore: ICliSessionStore,
): Router {
    const router = Router();
    const authMiddleware = createAuthMiddleware(sessionStore);

    // POST /login — no auth required
    router.post('/login', async (req: Request, res: Response): Promise<void> => {
        const { username, password } = req.body ?? {};
        if (!username || !password) {
            res.status(400).json({ error: 'username and password are required' });
            return;
        }

        try {
            const metadata = {
                remoteAddress: req.ip,
                userAgent: req.headers['user-agent'],
            };
            const { token, session } = await authService.login(username, password, metadata);
            res.json({ token, session });
        } catch (err: any) {
            res.status(401).json({ error: err.message ?? 'Invalid credentials' });
        }
    });

    // POST /logout — auth required
    router.post('/logout', authMiddleware, async (req: Request, res: Response): Promise<void> => {
        const authHeader = req.headers['authorization'] ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        await authService.logout(token);
        res.status(204).end();
    });

    // POST /verify — verify userId + password, returns { valid: boolean }
    router.post('/verify', async (req: Request, res: Response): Promise<void> => {
        const { userId, password } = req.body ?? {};
        if (!userId || !password) {
            res.status(400).json({ error: 'userId and password are required' });
            return;
        }
        const valid = await authService.verifyPassword(userId, password);
        res.json({ valid });
    });

    return router;
}
