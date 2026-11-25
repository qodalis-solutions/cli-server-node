import { Router, Request, Response } from 'express';
import { processMemoryMb, StatusSampler } from '../services/status-sampler';
import { readSystemMemory, SystemMemory } from '../services/system-memory';

/** Dependencies injected into the status controller for runtime metrics. */
export interface StatusDeps {
    getActiveWsConnections: () => number;
    getActiveShellSessions: () => number;
    getRegisteredCommands: () => number;
    getRegisteredJobs: () => number;
    getEnabledFeatures: () => string[];
}

const startedAt = new Date().toISOString();

/** Default and allowed minutes of `GET /status/history` and `admin status --history`. */
export const DEFAULT_HISTORY_MINUTES = 60;
export const MAX_HISTORY_MINUTES = 1440;

/** The server status (`GET /status` and `admin status`). */
export interface StatusSnapshot extends SystemMemory {
    uptimeSeconds: number;
    startedAt: string;
    /** Resident memory of the process in MB. */
    memoryUsageMb: number;
    cpuUsagePercent: number | null;
    platform: 'node';
    platformVersion: string;
    activeWsConnections: number;
    activeShellSessions: number;
    registeredCommands: number;
    registeredJobs: number;
    os: string;
    enabledFeatures: string[];
}

/**
 * Reads the server status now: process metrics, the machine's (or container's) memory, the latest CPU sample
 * and the counts of `deps`.
 */
export function statusSnapshot(deps: StatusDeps, sampler?: StatusSampler): StatusSnapshot {
    return {
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt,
        memoryUsageMb: processMemoryMb(),
        ...readSystemMemory(),
        cpuUsagePercent: sampler?.latest?.cpuPercent ?? null,
        platform: 'node',
        platformVersion: process.version,
        activeWsConnections: deps.getActiveWsConnections(),
        activeShellSessions: deps.getActiveShellSessions(),
        registeredCommands: deps.getRegisteredCommands(),
        registeredJobs: deps.getRegisteredJobs(),
        os: process.platform,
        enabledFeatures: deps.getEnabledFeatures(),
    };
}

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
        res.json(statusSnapshot(deps, sampler));
    });

    return router;
}
