import { Router, Request, Response } from 'express';

/** Dependency providing access to connected WebSocket client metadata. */
export interface WsClientsDeps {
    getClients: () => Array<{
        id: string;
        connectedAt: string;
        remoteAddress: string;
        type: string;
    }>;
}

/**
 * Creates the WebSocket clients controller router.
 *
 * Routes:
 * - GET / — list connected WebSocket clients
 */
export function createWsClientsController(deps: WsClientsDeps): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response): void => {
        res.json(deps.getClients());
    });

    return router;
}
