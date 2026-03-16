import { Router, Request, Response } from 'express';

export interface StatusDeps {
    getActiveWsConnections: () => number;
    getActiveShellSessions: () => number;
    getRegisteredCommands: () => number;
    getRegisteredJobs: () => number;
    getEnabledFeatures: () => string[];
}

const startedAt = new Date().toISOString();

/**
 * Creates the status controller router.
 *
 * Routes:
 * - GET / — server status overview
 */
export function createStatusController(deps: StatusDeps): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response): void => {
        const mem = process.memoryUsage();

        res.json({
            uptimeSeconds: Math.floor(process.uptime()),
            startedAt,
            memoryUsageMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
            cpuUsagePercent: null,
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
