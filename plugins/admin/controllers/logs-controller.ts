import { Router, Request, Response } from 'express';
import { LogRingBuffer } from '../services/log-ring-buffer';
import { clampBuckets, QueryError, resolveRange } from '../services/query-time';

/**
 * Creates the logs controller router.
 *
 * Routes:
 * - GET / — query log entries with optional filtering
 *   Query params: level (comma-separated), search, service, limit, offset
 * - GET /histogram — entries per level in equal columns of a time range
 *   Query params: from, to (default the last 24 hours), buckets (1..200, default 24),
 *   and the filters of GET /
 */
export function createLogsController(logBuffer: LogRingBuffer): Router {
    const router = Router();

    router.get('/histogram', (req: Request, res: Response): void => {
        const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
        let range: { from: Date; to: Date };
        try {
            range = resolveRange(req.query.from, req.query.to, 'from', 'to');
        } catch (err) {
            if (!(err instanceof QueryError)) throw err;
            res.status(400).json({ error: err.message });
            return;
        }
        res.json(logBuffer.histogram({
            ...range,
            buckets: clampBuckets(req.query.buckets),
            level: text(req.query.level),
            search: text(req.query.search),
            service: text(req.query.service),
        }));
    });

    router.get('/', (req: Request, res: Response): void => {
        const level = req.query.level as string | undefined;
        const search = req.query.search as string | undefined;
        const service = req.query.service as string | undefined;
        const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
        if (limit !== undefined && isNaN(limit)) {
            res.status(400).json({ error: 'limit must be a valid integer' });
            return;
        }
        const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
        if (offset !== undefined && isNaN(offset)) {
            res.status(400).json({ error: 'offset must be a valid integer' });
            return;
        }

        const result = logBuffer.query({ level, search, service, limit, offset });
        res.json(result);
    });

    return router;
}
