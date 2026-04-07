import { Router, Request, Response } from 'express';
import { ICliSessionStore } from '../stores/interfaces';
import { requireAdmin } from '../middleware/auth-middleware';

export function createSessionsController(
    sessionStore: ICliSessionStore,
    broadcastEvent?: (msg: Record<string, unknown>) => void,
): Router {
    const router = Router();

    // GET / — list all active sessions (admin only)
    router.get('/', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
        const sessions = await sessionStore.getActiveSessions();
        res.json(sessions);
    });

    // GET /current — return current session
    router.get('/current', (req: Request, res: Response): void => {
        res.json(req.session);
    });

    // DELETE /:id — kick/force-logout a session (admin only)
    router.delete('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        const session = await sessionStore.getSessionById(req.params.id);
        if (!session) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }

        await sessionStore.deleteSessionById(req.params.id);

        broadcastEvent?.({
            type: 'session-kicked',
            data: { sessionId: session.id, userId: session.userId },
        });

        res.status(204).end();
    });

    return router;
}
