import { Router } from 'express';
import { CliJobScheduler, JobError } from './cli-job-scheduler';
import { ICliJobStorageProvider, JobExecution, JobExecutionStatus } from '@qodalis/cli-server-abstractions';
import { buildJobStats, collectRuns, resolveStatsRange, StatsRange } from './cli-jobs-stats';

/**
 * Creates the jobs REST controller router.
 *
 * Routes (relative to mount point):
 * - GET    /            - list all jobs
 * - GET    /executions  - executions across jobs (?job=a,b&group=&status=&since=&limit=&offset=)
 * - GET    /stats       - run statistics for charts (?since=&until=&buckets=&job=&group=)
 * - GET    /:id         - single job details
 * - POST   /:id/trigger - trigger immediate execution
 * - POST   /:id/pause   - pause scheduled execution
 * - POST   /:id/resume  - resume a paused job
 * - POST   /:id/stop    - stop job and cancel if running
 * - POST   /:id/cancel  - cancel current execution only
 * - PUT    /:id         - update job options
 * - GET    /:id/history - paginated execution history
 * - GET    /:id/history/:execId - single execution with full logs
 * - DELETE /:id/history/:execId - delete one finished run and its logs
 * - DELETE /:id/history - delete every finished run (?status= for only those with that status)
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

    // Before /:id, which would take "executions" for a job id
    router.get('/executions', async (req, res) => {
        const jobIds = resolveJobIds(scheduler, req.query.job, req.query.group);

        let since: Date | undefined;
        if (typeof req.query.since === 'string' && req.query.since) {
            since = new Date(req.query.since);
            if (Number.isNaN(since.getTime())) {
                return res.status(400).json({ error: 'since must be an ISO 8601 date', code: 'INVALID_QUERY' });
            }
        }
        const parsedLimit = parseInt(req.query.limit as string, 10);
        const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 1), 100);
        const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
        const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;

        try {
            // A group (or a job filter) matching no job lists nothing, not every job
            const result = jobIds && jobIds.length === 0
                ? { items: [], total: 0 }
                : await scheduler.queryExecutions({ jobIds, status, since, limit, offset });
            res.json({ items: result.items.map(toListItem), total: result.total, limit, offset });
        } catch (err) {
            handleError(res, err);
        }
    });

    // Before /:id, which would take "stats" for a job id
    router.get('/stats', async (req, res) => {
        let range: StatsRange;
        try {
            range = resolveStatsRange(req.query.since, req.query.until, req.query.buckets);
        } catch (err) {
            return res.status(400).json({ error: (err as Error).message, code: 'INVALID_QUERY' });
        }
        const jobIds = resolveJobIds(scheduler, req.query.job, req.query.group);
        try {
            // A group (or a job filter) matching no job gives empty stats, not every job
            const runs = jobIds && jobIds.length === 0
                ? []
                : await collectRuns((query) => scheduler.queryExecutions(query), jobIds, range);
            res.json(buildJobStats(runs, range));
        } catch (err) {
            handleError(res, err);
        }
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
        const items = result.items.map(toListItem);

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

        res.json({ ...execution, properties: execution.properties ?? {} });
    });

    router.delete('/:id/history/:execId', async (req, res) => {
        try {
            await scheduler.deleteExecutionAsync(req.params.id, req.params.execId);
            res.json({ message: 'Run deleted' });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.delete('/:id/history', async (req, res) => {
        const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
        try {
            const deleted = await scheduler.deleteExecutionsAsync(req.params.id, status);
            res.json({ deleted });
        } catch (err) {
            handleError(res, err);
        }
    });

    return router;
}

/** An execution in a list: without its logs, with their count and the run's properties. */
function toListItem(exec: JobExecution): Omit<JobExecution, 'logs'> & { logCount: number } {
    const { logs, ...rest } = exec;
    return { ...rest, properties: exec.properties ?? {}, logCount: logs?.length ?? 0 };
}

/**
 * The jobs named by `job` (repeatable or comma-separated) within `group` (case-insensitive):
 * undefined for every job, an empty list when the filters match no job.
 */
function resolveJobIds(scheduler: CliJobScheduler, job: unknown, groupValue: unknown): string[] | undefined {
    const jobIds = queryList(job).flatMap((j) => j.split(',').map((id) => id.trim()).filter(Boolean));
    const group = typeof groupValue === 'string' && groupValue.trim() ? groupValue.trim() : undefined;
    if (group) {
        const inGroup = scheduler
            .getAll()
            .filter((j) => j.group !== undefined && j.group.toLowerCase() === group.toLowerCase())
            .map((j) => j.id);
        return jobIds.length > 0 ? jobIds.filter((id) => inGroup.includes(id)) : inGroup;
    }
    return jobIds.length === 0 ? undefined : jobIds;
}

/** A query parameter given once, repeated or not at all, as a list of strings. */
function queryList(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    return [];
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
