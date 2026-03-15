import { Router, Request, Response } from 'express';
import { LogRingBuffer } from '../services/log-ring-buffer';

/**
 * Creates the logs controller router.
 *
 * Routes:
 * - GET / — query log entries with optional filtering
 *   Query params: level, search, limit, offset
 */
export function createLogsController(logBuffer: LogRingBuffer): Router {
    const router = Router();

    router.get('/', (req: Request, res: Response): void => {
        const level = req.query.level as string | undefined;
        const search = req.query.search as string | undefined;
        const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
        const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

        const result = logBuffer.query({ level, search, limit, offset });
        res.json(result);
    });

    return router;
}
