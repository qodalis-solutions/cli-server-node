import { Router, Request, Response } from 'express';
import { CliServerRestartError } from '@qodalis/cli-server-abstractions';
import type { CliServerRestart } from './cli-server-restart';

/**
 * `/api/v1/qcli/server/restart`: `GET` the status (`admin:access` on a protected server), `POST { reason? }`
 * restarts (`server:restart`): 202 `{ restarting: true, pending }`, then the graceful shutdown. The route
 * permissions are checked by the server's auth gate.
 */
export function createRestartController(restart: CliServerRestart): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response) => {
        res.json(restart.status());
    });

    router.post('/', async (req: Request, res: Response) => {
        const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
        const auth = req.qcliServerAuth;
        try {
            const result = await restart.restart({
                reason: body.reason as string | undefined,
                ...(auth ? { actor: { userId: auth.userId, userName: auth.userName } } : {}),
                via: 'api',
            });
            res.status(202).json(result);
        } catch (err) {
            if (err instanceof CliServerRestartError || (err as Error)?.name === 'CliServerRestartError') {
                res.status((err as CliServerRestartError).status).json({ error: (err as Error).message });
                return;
            }
            res.status(500).json({ error: 'internal server error' });
        }
    });

    return router;
}
