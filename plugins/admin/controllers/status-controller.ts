import { Router, Request, Response } from 'express';
import { processMemoryMb, StatusSampler } from '../services/status-sampler';

/** Dependencies injected into the status controller for runtime metrics. */
export interface StatusDeps {
    getActiveWsConnections: () => number;
    getActiveShellSessions: () => number;
    getRegisteredCommands: () => number;
    getRegisteredJobs: () => number;
    getEnabledFeatures: () => string[];
}

const startedAt = new Date().toISOString();

/** Default and allowed minutes of `GET /status/history`. */
const DEFAULT_HISTORY_MINUTES = 60;
const MAX_HISTORY_MINUTES = 1440;

/**
 * Creates the status controller router.
 *
 * Routes:
 * - GET / — server status overview
 * - GET /history?minutes= — the samples of the last minutes (default 60, 1..1440), oldest first
 */
export function createStatusController(deps: StatusDeps, sampler?: StatusSampler): Router {
    const router = Router();

    router.get('/history', (req: Request, res: Response): void => {
        const parsed = typeof req.query.minutes === 'string' ? parseInt(req.query.minutes, 10) : NaN;
        const minutes = Number.isNaN(parsed)
            ? DEFAULT_HISTORY_MINUTES
            : Math.min(Math.max(parsed, 1), MAX_HISTORY_MINUTES);
        res.json({
            intervalSeconds: sampler?.intervalSeconds ?? 15,
            samples: sampler?.history(minutes) ?? [],
        });
    });

    router.get('/', (_req: Request, res: Response): void => {
        res.json({
            uptimeSeconds: Math.floor(process.uptime()),
            startedAt,
            memoryUsageMb: processMemoryMb(),
            cpuUsagePercent: sampler?.latest?.cpuPercent ?? null,
            platform: 'node',
            platformVersion: process.version,
            activeWsConnections: deps.getActiveWsConnections(),
            activeShellSessions: deps.getActiveShellSessions(),
            registeredCommands: deps.getRegisteredCommands(),
            registeredJobs: deps.getRegisteredJobs(),
            os: process.platform,
            enabledFeatures: deps.getEnabledFeatures(),
        });
    });

    return router;
}
