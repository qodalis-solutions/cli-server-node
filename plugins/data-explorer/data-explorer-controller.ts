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

    router.get('/schema', async (req: Request, res: Response) => {
        const source = req.query.source as string;
        if (!source) {
            res.status(400).json({ error: '"source" query parameter is required.' });
            return;
        }

        const entry = registry.get(source);
        if (!entry) {
            res.status(404).json({ error: `Unknown data source: '${source}'` });
            return;
        }

        const { provider, options } = entry;
        if (!provider.getSchemaAsync) {
            res.status(404).json({ error: 'Schema introspection is not supported by this data source.' });
            return;
        }

        try {
            const schema = await provider.getSchemaAsync(options);
            res.json(schema);
        } catch (err: any) {
            res.status(500).json({ error: err.message ?? String(err) });
        }
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
