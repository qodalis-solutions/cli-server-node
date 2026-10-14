import { Router, Request, Response, RequestHandler } from 'express';
import { ICliSessionStore } from '../stores/interfaces';
import { AuthService } from '../services/auth-service';
import { requireAdmin } from '../middleware/auth-middleware';

export interface SessionsControllerOptions {
    /** When true, authentication is managed by the host app: login/logout return 501 */
    externalAuth?: boolean;
    /** Broadcasts server events (e.g. `session-kicked`) over the events WebSocket */
    broadcastEvent?: (msg: Record<string, unknown>) => void;
}

/**
 * Sessions resource.
 *
 * - `POST   /`         — login: create a session from credentials (no auth)
 * - `GET    /current`  — current session
 * - `DELETE /current`  — logout: end the current session
 * - `GET    /`         — list active sessions (admin)
 * - `DELETE /:id`      — kick a session (admin)
 */
export function createSessionsController(
    sessionStore: ICliSessionStore,
    authService: AuthService,
    authMiddleware: RequestHandler,
    options: SessionsControllerOptions = {},
): Router {
    const router = Router();
    const { externalAuth, broadcastEvent } = options;

    const notAvailable = (_req: Request, res: Response): void => {
        res.status(501).json({ error: 'Authentication is managed by the host application' });
    };

    // Login/logout are owned by the host application in external-auth mode
    if (externalAuth) {
        router.post('/', notAvailable);
        router.delete('/current', notAvailable);
    } else {
        // POST / — login (no auth required)
        router.post('/', async (req: Request, res: Response): Promise<void> => {
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
                res.status(201).json({ token, session });
            } catch (err: any) {
                res.status(401).json({ error: err.message ?? 'Invalid credentials' });
            }
        });
    }

    // Everything below requires an authenticated session
    router.use(authMiddleware);

    // GET /current — return current session
    router.get('/current', (req: Request, res: Response): void => {
        res.json(req.session);
    });

    // DELETE /current — logout
    if (!externalAuth) {
        router.delete('/current', async (req: Request, res: Response): Promise<void> => {
            const authHeader = req.headers['authorization'] ?? '';
            const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            await authService.logout(token);
            res.status(204).end();
        });
    }

    // GET / — list all active sessions (admin only)
    router.get('/', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
        const sessions = await sessionStore.getActiveSessions();
        res.json(sessions);
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
