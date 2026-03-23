import { Router } from 'express';
import { CliJobScheduler, JobError } from './cli-job-scheduler';
import { ICliJobStorageProvider, JobExecutionStatus } from '@qodalis/cli-server-abstractions';

/**
 * Creates the jobs REST controller router.
 *
 * Routes (relative to mount point):
 * - GET    /            - list all jobs
 * - GET    /:id         - single job details
 * - POST   /:id/trigger - trigger immediate execution
 * - POST   /:id/pause   - pause scheduled execution
 * - POST   /:id/resume  - resume a paused job
 * - POST   /:id/stop    - stop job and cancel if running
 * - POST   /:id/cancel  - cancel current execution only
 * - PUT    /:id         - update job options
 * - GET    /:id/history - paginated execution history
 * - GET    /:id/history/:execId - single execution with full logs
 *
 * @param scheduler - The job scheduler managing registrations and execution.
 * @param storage - Storage provider for execution history lookups.
 * @returns An Express router.
 */
export function createCliJobsController(
    scheduler: CliJobScheduler,
    storage: ICliJobStorageProvider,
): Router {
    const router = Router();

    router.get('/', (_req, res) => {
        const jobs = scheduler.getAll();
        res.json(jobs);
    });

    router.get('/:id', (req, res) => {
        const job = scheduler.get(req.params.id);
        if (!job) {
            return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
        }
        res.json(job);
    });

    router.post('/:id/trigger', async (req, res) => {
        try {
            await scheduler.triggerAsync(req.params.id);
            res.json({ ok: true });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.post('/:id/pause', async (req, res) => {
        try {
            await scheduler.pauseAsync(req.params.id);
            res.json({ ok: true });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.post('/:id/resume', async (req, res) => {
        try {
            await scheduler.resumeAsync(req.params.id);
            res.json({ ok: true });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.post('/:id/stop', async (req, res) => {
        try {
            await scheduler.stopJobAsync(req.params.id);
            res.json({ ok: true });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.post('/:id/cancel', async (req, res) => {
        try {
            await scheduler.cancelCurrentAsync(req.params.id);
            res.json({ ok: true });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.put('/:id', async (req, res) => {
        try {
            const { description, group, schedule, interval, maxRetries, retryDelay, retryStrategy, timeout, overlapPolicy } = req.body ?? {};
            await scheduler.updateOptionsAsync(req.params.id, {
                description,
                group,
                schedule,
                interval,
                maxRetries,
                retryDelay,
                retryStrategy,
                timeout,
                overlapPolicy,
            });
            const updated = scheduler.get(req.params.id);
            res.json(updated);
        } catch (err) {
            handleError(res, err);
        }
    });

    router.get('/:id/history', async (req, res) => {
        const reg = scheduler.getRegistration(req.params.id);
        if (!reg) {
            return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
        }

        const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);
        const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
        const status = req.query.status as JobExecutionStatus | undefined;

        const result = await storage.getExecutions(req.params.id, { limit, offset, status });

        // Strip logs from list view, add logCount
        const items = result.items.map((exec) => {
            const { logs, ...rest } = exec;
            return { ...rest, logCount: logs?.length ?? 0 };
        });

        res.json({
            items,
            total: result.total,
            limit,
            offset,
        });
    });

    router.get('/:id/history/:execId', async (req, res) => {
        const reg = scheduler.getRegistration(req.params.id);
        if (!reg) {
            return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
        }

        const execution = await storage.getExecution(req.params.execId);
        if (!execution || execution.jobId !== req.params.id) {
            return res.status(404).json({ error: 'Execution not found', code: 'EXECUTION_NOT_FOUND' });
        }

        res.json(execution);
    });

    return router;
}

/** Map a caught error to an appropriate HTTP response. */
function handleError(res: import('express').Response, err: unknown): void {
    if (err instanceof JobError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
    } else {
        res.status(500).json({
            error: err instanceof Error ? err.message : 'Internal server error',
            code: 'INTERNAL_ERROR',
        });
    }
}
