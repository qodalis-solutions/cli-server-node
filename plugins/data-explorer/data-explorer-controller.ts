import { Router, Request, Response } from 'express';
import { DataExplorerExecuteRequest } from '@qodalis/cli-server-abstractions';
import { DataExplorerRegistry } from './data-explorer-registry';
import { DataExplorerExecutor } from './data-explorer-executor';

export function createDataExplorerController(
    registry: DataExplorerRegistry,
    executor: DataExplorerExecutor,
): Router {
    const router = Router();

    router.get('/sources', (_req: Request, res: Response) => {
        res.json(registry.getSources());
    });

    router.post('/execute', async (req: Request, res: Response) => {
        const body = req.body as DataExplorerExecuteRequest;

        if (!body || !body.source || !body.query) {
            res.status(400).json({
                error: 'Request body must include "source" and "query" fields.',
            });
            return;
        }

        const result = await executor.executeAsync(body);
        res.json(result);
    });

    return router;
}
