import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    ICliJob,
    ICliJobExecutionContext,
    ICliJobStorageProvider,
    JobExecution,
    JobExecutionStatus,
    selectRunsBreakingRetention,
} from '@qodalis/cli-server-abstractions';
import { InMemoryJobStorageProvider } from '../../plugins/jobs/in-memory-job-storage-provider';
import { CliJobScheduler } from '../../plugins/jobs/cli-job-scheduler';
import { CliJobsBuilder } from '../../plugins/jobs/cli-jobs-builder';
import { HISTORY_PRUNE_JOB_ID } from '../../plugins/jobs/job-history-prune-job';
import { formatDuration, parseDuration } from '../../plugins/jobs/interval-parser';

const DAY = 86_400_000;
const NOW = Date.now();

class NoopJob implements ICliJob {
    async executeAsync(_context: ICliJobExecutionContext): Promise<void> {}
}

let seq = 0;

/** Saves a run of `jobId` that started `ageMs` ago. */
async function seed(storage: ICliJobStorageProvider, jobId: string, ageMs: number, status: JobExecutionStatus = 'completed'): Promise<JobExecution> {
    const execution: JobExecution = {
        id: `run-${++seq}`,
        jobId,
        jobName: jobId,
        status,
        startedAt: new Date(NOW - ageMs).toISOString(),
        logs: [],
        retryAttempt: 0,
    };
    await storage.saveExecution(execution);
    return execution;
}

async function idsOf(storage: ICliJobStorageProvider, jobId: string): Promise<string[]> {
    return (await storage.getExecutions(jobId, { limit: 1000 })).items.map((e) => e.id);
}

async function untilIdle(scheduler: CliJobScheduler, id: string): Promise<void> {
    const reg = scheduler.jobs.get(id)!;
    const start = Date.now();
    while (reg.runs.size > 0 || reg.queued) {
        if (Date.now() - start > 5_000) throw new Error(`job ${id} still running`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe('job history retention', () => {
    let scheduler: CliJobScheduler | undefined;

    afterEach(async () => {
        await scheduler?.stop();
        scheduler = undefined;
    });

    it('deletes runs older than maxAge, keeping the newest run', async () => {
        const storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage, { history: { maxAge: '30d' } });
        scheduler.register(new NoopJob(), { id: 'a' });
        scheduler.register(new NoopJob(), { id: 'old' });
        await seed(storage, 'a', 40 * DAY);
        const recent = await seed(storage, 'a', 1 * DAY);
        const onlyOld = await seed(storage, 'old', 90 * DAY);

        expect(await scheduler.pruneHistoryAsync()).toBe(1);
        expect(await idsOf(storage, 'a')).toEqual([recent.id]);
        // The latest run of a job is never deleted, whatever its age
        expect(await idsOf(storage, 'old')).toEqual([onlyOld.id]);
    });

    it('keeps at most maxRunsPerJob runs per job, the newest', async () => {
        const storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage, { history: { maxRunsPerJob: 2 } });
        scheduler.register(new NoopJob(), { id: 'a' });
        const runs = [];
        for (let i = 5; i >= 1; i--) runs.push(await seed(storage, 'a', i * 1000));

        expect(await scheduler.pruneHistoryAsync()).toBe(3);
        expect(await idsOf(storage, 'a')).toEqual([runs[4].id, runs[3].id]);
    });

    it('applies failedMaxAge and failedMaxRunsPerJob to failed runs', async () => {
        const storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage, {
            history: { maxAge: '7d', maxRunsPerJob: 2, failedMaxAge: '90d', failedMaxRunsPerJob: 1 },
        });
        scheduler.register(new NoopJob(), { id: 'a' });
        await seed(storage, 'a', 30 * DAY, 'failed');
        const failedNew = await seed(storage, 'a', 20 * DAY, 'failed');
        await seed(storage, 'a', 10 * DAY);
        await seed(storage, 'a', 3 * DAY);
        const c2 = await seed(storage, 'a', 2 * DAY);
        const c3 = await seed(storage, 'a', 1 * DAY);

        await scheduler.pruneHistoryAsync();
        // failedNew: 20 days < 90 and the newest failed run; failedOld: beyond 1 failed run;
        // completedOld: older than 7 days; c1: beyond 2 other runs
        expect(await idsOf(storage, 'a')).toEqual([c3.id, c2.id, failedNew.id]);
    });

    it('counts failed runs with the others when failedMaxRunsPerJob is not set', () => {
        const runs = [
            { id: '1', status: 'completed', startedAt: new Date(NOW - 1000).toISOString() },
            { id: '2', status: 'failed', startedAt: new Date(NOW - 2000).toISOString() },
            { id: '3', status: 'completed', startedAt: new Date(NOW - 3000).toISOString() },
        ];
        expect(selectRunsBreakingRetention(runs, { maxRuns: 2 }, new Date(NOW)).map((r) => r.id)).toEqual(['3']);
    });

    it('lets a job override the global limits and keep everything', async () => {
        const storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage, { history: { maxAge: '1d', maxRunsPerJob: 10 } });
        scheduler.register(new NoopJob(), { id: 'noisy', history: { maxRunsPerJob: 1 } });
        scheduler.register(new NoopJob(), { id: 'report', history: { keepAll: true } });
        scheduler.register(new NoopJob(), { id: 'plain' });
        for (const id of ['noisy', 'report', 'plain']) {
            await seed(storage, id, 5 * DAY);
            await seed(storage, id, 1000);
            await seed(storage, id, 500);
        }

        await scheduler.pruneHistoryAsync();
        // noisy: 1 run (and maxAge still 1d from the global); report: everything; plain: within 1 day
        expect(await idsOf(storage, 'noisy')).toHaveLength(1);
        expect(await idsOf(storage, 'report')).toHaveLength(3);
        expect(await idsOf(storage, 'plain')).toHaveLength(2);
    });

    it('never deletes running runs', async () => {
        const storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage, { history: { maxAge: '1d', maxRunsPerJob: 1 } });
        scheduler.register(new NoopJob(), { id: 'a' });
        const running = await seed(storage, 'a', 10 * DAY, 'running');
        await seed(storage, 'a', 5 * DAY);
        const newest = await seed(storage, 'a', 1000);

        expect(await scheduler.pruneHistoryAsync()).toBe(1);
        expect(await idsOf(storage, 'a')).toEqual([newest.id, running.id]);
    });

    it('prunes the runs of jobs no longer registered under the global limits', async () => {
        const storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage, { history: { maxRunsPerJob: 1 } });
        await seed(storage, 'gone', 2000);
        const newest = await seed(storage, 'gone', 1000);
        expect(await scheduler.pruneHistoryAsync()).toBe(1);
        expect(await idsOf(storage, 'gone')).toEqual([newest.id]);
    });

    it('falls back to an age-only prune when the storage has no pruneHistory', async () => {
        const inner = new InMemoryJobStorageProvider();
        const pruned: Date[] = [];
        const plain: ICliJobStorageProvider = {
            saveExecution: (e) => inner.saveExecution(e),
            getExecutions: (id, o) => inner.getExecutions(id, o),
            getExecution: (id) => inner.getExecution(id),
            saveJobState: (id, s) => inner.saveJobState(id, s),
            getJobState: (id) => inner.getJobState(id),
            getAllJobStates: () => inner.getAllJobStates(),
            prune: (before) => {
                pruned.push(before);
                return inner.prune(before);
            },
        };
        scheduler = new CliJobScheduler(plain, { history: { maxAge: '10d', failedMaxAge: '30d' } });
        scheduler.register(new NoopJob(), { id: 'a' });
        await seed(plain, 'a', 40 * DAY);
        await seed(plain, 'a', 20 * DAY);
        expect(await scheduler.pruneHistoryAsync()).toBe(1);
        // The oldest limit wins, so failed runs are not cut short
        expect(Math.round((Date.now() - pruned[0].getTime()) / DAY)).toBe(30);

        // A keep-all job (or one without an age limit) disables the fallback
        const s2 = new CliJobScheduler(plain, { history: { maxAge: '1d' } });
        s2.register(new NoopJob(), { id: 'a' });
        s2.register(new NoopJob(), { id: 'b', history: { keepAll: true } });
        expect(await s2.pruneHistoryAsync()).toBe(0);
    });

    it('validates the limits', () => {
        const storage = new InMemoryJobStorageProvider();
        expect(() => new CliJobScheduler(storage, { history: { maxAge: 'soon' } })).toThrow(/maxAge/);
        expect(() => new CliJobScheduler(storage, { history: { maxRunsPerJob: 0 } })).toThrow(/maxRunsPerJob/);
        expect(() => new CliJobScheduler(storage, { history: { pruneInterval: -1 } })).toThrow(/pruneInterval/);
        const s = new CliJobScheduler(storage);
        expect(() => s.register(new NoopJob(), { id: 'x', history: { failedMaxRunsPerJob: 1.5 } })).toThrow(/failedMaxRunsPerJob/);
    });

    it('parses and formats durations', () => {
        expect(parseDuration('30d')).toBe(30 * DAY);
        expect(parseDuration(1500)).toBe(1500);
        expect(parseDuration(0)).toBeNull();
        expect(formatDuration(DAY)).toBe('1d');
        expect(formatDuration(90 * 60_000)).toBe('90m');
        expect(formatDuration(1500)).toBe('2s');
    });

    describe('jobs:prune-history', () => {
        it('is not registered without retention', () => {
            const plugin = new CliJobsBuilder()
                .addJob(new NoopJob(), { id: 'a', interval: '1h', history: { keepAll: true } })
                .build();
            scheduler = plugin.scheduler;
            expect(scheduler.get(HISTORY_PRUNE_JOB_ID)).toBeUndefined();
        });

        it('is registered with global retention, every pruneInterval, in group system', () => {
            const plugin = new CliJobsBuilder({ history: { maxAge: '30d', pruneInterval: '6h' } }).build();
            scheduler = plugin.scheduler;
            const job = scheduler.get(HISTORY_PRUNE_JOB_ID)!;
            expect(job).toMatchObject({ id: 'jobs:prune-history', name: 'jobs:prune-history', group: 'system', interval: '6h', status: 'active' });
            expect(job.tags).toContain('system');
            // Its own history follows the global limits
            expect(job.historyRetention).toEqual({
                maxAge: '30d', maxRunsPerJob: null, failedMaxAge: null, failedMaxRunsPerJob: null, overridden: false, keepAll: false,
            });
        });

        it('defaults pruneInterval to 1 day and is registered by per-job retention alone', () => {
            const plugin = new CliJobsBuilder()
                .addJob(new NoopJob(), { id: 'a', history: { maxRunsPerJob: 5 } })
                .build();
            scheduler = plugin.scheduler;
            expect(scheduler.get(HISTORY_PRUNE_JOB_ID)?.interval).toBe('1d');
            expect(scheduler.get(HISTORY_PRUNE_JOB_ID)?.historyRetention).toBeNull();
        });

        it('is registered on start for jobs registered after build', async () => {
            const storage = new InMemoryJobStorageProvider();
            scheduler = new CliJobScheduler(storage);
            scheduler.register(new NoopJob(), { id: 'a', history: { maxAge: 1000 } });
            expect(scheduler.get(HISTORY_PRUNE_JOB_ID)).toBeUndefined();
            await scheduler.start();
            expect(scheduler.get(HISTORY_PRUNE_JOB_ID)).toBeDefined();
        });

        it('records how many runs it deleted in the deleted property and its log', async () => {
            const storage = new InMemoryJobStorageProvider();
            const plugin = new CliJobsBuilder({ history: { maxRunsPerJob: 1 } })
                .setStorageProvider(storage)
                .addJob(new NoopJob(), { id: 'a' })
                .build();
            scheduler = plugin.scheduler;
            for (let i = 3; i >= 1; i--) await seed(storage, 'a', i * 1000);
            await scheduler.start();

            await scheduler.triggerAsync(HISTORY_PRUNE_JOB_ID);
            await untilIdle(scheduler, HISTORY_PRUNE_JOB_ID);
            const [run] = (await storage.getExecutions(HISTORY_PRUNE_JOB_ID)).items;
            expect(run.status).toBe('completed');
            expect(run.properties).toEqual({ deleted: 2 });
            expect(run.logs.map((l) => l.message)).toContain('Deleted 2 job executions past the history retention');
            expect(await idsOf(storage, 'a')).toHaveLength(1);

            // Pausable like any job
            await scheduler.pauseAsync(HISTORY_PRUNE_JOB_ID);
            expect(scheduler.get(HISTORY_PRUNE_JOB_ID)?.status).toBe('paused');
        });
    });

    describe('historyRetention in job info', () => {
        it('is the effective limits, overridden per job, null when none apply', async () => {
            const plugin = new CliJobsBuilder()
                .setHistory({ maxAge: 30 * DAY, failedMaxAge: '90d' })
                .addJob(new NoopJob(), { id: 'plain', interval: '1h' })
                .addJob(new NoopJob(), { id: 'noisy', interval: '1h', history: { maxRunsPerJob: 50, maxAge: '2d' } })
                .addJob(new NoopJob(), { id: 'report', interval: '1h', history: { keepAll: true } })
                .build();
            scheduler = plugin.scheduler;
            const app = express();
            app.use(express.json());
            app.use(plugin.prefix, plugin.router);

            const list = await request(app).get('/api/v1/qcli/jobs');
            const byId = Object.fromEntries(list.body.map((j: any) => [j.id, j.historyRetention]));
            expect(byId.plain).toEqual({
                maxAge: '30d', maxRunsPerJob: null, failedMaxAge: '90d', failedMaxRunsPerJob: null, overridden: false, keepAll: false,
            });
            expect(byId.noisy).toEqual({
                maxAge: '2d', maxRunsPerJob: 50, failedMaxAge: '90d', failedMaxRunsPerJob: null, overridden: true, keepAll: false,
            });
            expect(byId.report).toEqual({
                maxAge: null, maxRunsPerJob: null, failedMaxAge: null, failedMaxRunsPerJob: null, overridden: true, keepAll: true,
            });

            const one = await request(app).get('/api/v1/qcli/jobs/noisy');
            expect(one.body.historyRetention.maxRunsPerJob).toBe(50);
        });

        it('is null without any retention', () => {
            const plugin = new CliJobsBuilder().addJob(new NoopJob(), { id: 'a', interval: '1h' }).build();
            scheduler = plugin.scheduler;
            expect(scheduler.get('a')?.historyRetention).toBeNull();
        });
    });
});
