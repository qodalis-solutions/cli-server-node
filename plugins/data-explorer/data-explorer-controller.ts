import { Router, Request, Response } from 'express';
import { DataExplorerCaller, DataExplorerExecuteRequest } from '@qodalis/cli-server-abstractions';
import { DataExplorerRegistry } from './data-explorer-registry';
import { DataExplorerExecutor } from './data-explorer-executor';
import { filterSchema, missingPermissions } from './data-explorer-policy';

/** Options of the data explorer routes. */
export interface DataExplorerControllerOptions {
    /** Who makes a request (permissions, rate limit, audit); the server supplies it. */
    caller?: (req: Request) => DataExplorerCaller | undefined;
}

/**
 * Creates the data explorer REST controller router.
 *
 * Routes (relative to mount point):
 * - GET  /sources  - list the data sources the caller may use
 * - GET  /schema   - introspect a source's schema (allowed tables, without dropped columns)
 * - POST /execute  - execute a query against a source (403 without the source's
 *   permissions, 429 over its rate limit)
 *
 * @param registry - Registry of available data sources.
 * @param executor - Service that runs queries with the source's rules and limits.
 * @param options - How to tell who makes a request.
 * @returns An Express router.
 */
export function createDataExplorerController(
    registry: DataExplorerRegistry,
    executor: DataExplorerExecutor,
    options: DataExplorerControllerOptions = {},
): Router {
    const router = Router();
    const callerOf = (req: Request) => options.caller?.(req);

    router.get('/sources', (req: Request, res: Response) => {
        res.json(registry.getSources(callerOf(req)));
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

        const { provider, options: sourceOptions } = entry;
        const missing = missingPermissions(sourceOptions.requiredPermissions, callerOf(req));
        if (missing.length) {
            res.status(403).json({ error: `forbidden: missing permission ${missing.join(', ')}` });
            return;
        }
        if (!provider.getSchemaAsync) {
            res.status(404).json({ error: 'Schema introspection is not supported by this data source.' });
            return;
        }

        try {
            const schema = await provider.getSchemaAsync(sourceOptions);
            res.json(filterSchema(schema, sourceOptions));
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

        const result = await executor.executeAsync(body, callerOf(req));
        if (result.errorCode === 'forbidden') {
            res.status(403).json({ error: result.error });
            return;
        }
        if (result.errorCode === 'rate_limited') {
            res.status(429).json({ error: result.error });
            return;
        }
        res.json(result);
    });

    return router;
}
