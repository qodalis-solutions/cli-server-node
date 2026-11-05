import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    ICliJob,
    ICliJobExecutionContext,
    CliJobOptions,
    JobExecution,
    JobState,
    ICliJobStorageProvider,
    queryJobExecutions,
    pruneJobExecutions,
    deleteJobExecution,
} from '@qodalis/cli-server-abstractions';

// Use relative paths since these are not aliased in vitest config
import { parseInterval } from '../../plugins/jobs/interval-parser';
import { CliJobLogger } from '../../plugins/jobs/cli-job-logger';
import { CliJobExecutionContext } from '../../plugins/jobs/cli-job-execution-context';
import { InMemoryJobStorageProvider } from '../../plugins/jobs/in-memory-job-storage-provider';
import { CliJobScheduler, JobError } from '../../plugins/jobs/cli-job-scheduler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class DummyJob implements ICliJob {
    callCount = 0;
    private _sleep: number;
    private _fail: boolean;

    constructor(opts: { sleep?: number; fail?: boolean } = {}) {
        this._sleep = opts.sleep ?? 0;
        this._fail = opts.fail ?? false;
    }

    async executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void> {
        this.callCount++;
        context.logger.info('started');
        if (this._sleep) {
            // Sleep in small increments so abort signal can be detected
            const end = Date.now() + this._sleep;
            while (Date.now() < end) {
                if (signal.aborted) {
                    context.logger.warning('cancelled');
                    return;
                }
                await new Promise((r) => setTimeout(r, Math.min(20, end - Date.now())));
            }
        }
        if (signal.aborted) {
            context.logger.warning('cancelled');
            return;
        }
        if (this._fail) {
            throw new Error('boom');
        }
        context.logger.info('done');
    }
}

class SlowCancellableJob implements ICliJob {
    async executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void> {
        context.logger.info('starting slow job');
        for (let i = 0; i < 50; i++) {
            if (signal.aborted) {
                context.logger.info('detected cancellation');
                return;
            }
            await new Promise((r) => setTimeout(r, 20));
        }
        context.logger.info('slow job completed');
    }
}

// ---------------------------------------------------------------------------
// Interval parser
// ---------------------------------------------------------------------------

describe('parseInterval', () => {
    it('parses seconds', () => {
        expect(parseInterval('30s')).toBe(30_000);
    });

    it('parses minutes', () => {
        expect(parseInterval('5m')).toBe(300_000);
    });

    it('parses hours', () => {
        expect(parseInterval('1h')).toBe(3_600_000);
    });

    it('parses days', () => {
        expect(parseInterval('1d')).toBe(86_400_000);
    });

    it('returns null for invalid format', () => {
        expect(parseInterval('abc')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(parseInterval('')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

describe('CliJobLogger', () => {
    it('captures entries at all levels', () => {
        const log = new CliJobLogger();
        log.debug('d');
        log.info('i');
        log.warning('w');
        log.error('e');

        expect(log.entries).toHaveLength(4);
        expect(log.entries[0].level).toBe('debug');
        expect(log.entries[1].level).toBe('info');
        expect(log.entries[2].level).toBe('warning');
        expect(log.entries[3].level).toBe('error');
        expect(log.entries[0].message).toBe('d');
    });
});

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

describe('CliJobExecutionContext', () => {
    it('logger captures entries', () => {
        const ctx = new CliJobExecutionContext();
        ctx.logger.info('hello');
        expect(ctx.logEntries).toHaveLength(1);
        expect(ctx.logEntries[0].message).toBe('hello');
    });
});

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------

describe('InMemoryJobStorageProvider', () => {
    let storage: InMemoryJobStorageProvider;

    beforeEach(() => {
        storage = new InMemoryJobStorageProvider();
    });

    it('saves and retrieves execution', async () => {
        const ex: JobExecution = {
            id: 'e1',
            jobId: 'j1',
            jobName: 'test',
            status: 'completed',
            startedAt: new Date().toISOString(),
            logs: [],
            retryAttempt: 0,
        };
        await storage.saveExecution(ex);
        const result = await storage.getExecution('e1');
        expect(result).not.toBeNull();
        expect(result!.id).toBe('e1');
    });

    it('paginates executions', async () => {
        for (let i = 0; i < 5; i++) {
            await storage.saveExecution({
                id: `e${i}`,
                jobId: 'j1',
                jobName: 't',
                status: 'completed',
                startedAt: new Date().toISOString(),
                logs: [],
                retryAttempt: 0,
            });
        }
        const result = await storage.getExecutions('j1', { limit: 2, offset: 1 });
        expect(result.total).toBe(5);
        expect(result.items).toHaveLength(2);
    });

    it('filters executions by status', async () => {
        await storage.saveExecution({
            id: 'e1',
            jobId: 'j1',
            jobName: 't',
            status: 'completed',
            startedAt: new Date().toISOString(),
            logs: [],
            retryAttempt: 0,
        });
        await storage.saveExecution({
            id: 'e2',
            jobId: 'j1',
            jobName: 't',
            status: 'failed',
            startedAt: new Date().toISOString(),
            logs: [],
            retryAttempt: 0,
        });
        const result = await storage.getExecutions('j1', { status: 'failed' });
        expect(result.total).toBe(1);
        expect(result.items[0].id).toBe('e2');
    });

    it('saves and retrieves job state', async () => {
        const state: JobState = { status: 'paused', updatedAt: new Date().toISOString() };
        await storage.saveJobState('j1', state);
        const result = await storage.getJobState('j1');
        expect(result).not.toBeNull();
        expect(result!.status).toBe('paused');
    });

    it('gets all job states', async () => {
        await storage.saveJobState('j1', { status: 'active', updatedAt: new Date().toISOString() });
        await storage.saveJobState('j2', { status: 'stopped', updatedAt: new Date().toISOString() });
        const states = await storage.getAllJobStates();
        expect(states.size).toBe(2);
    });

    it('returns null for nonexistent execution', async () => {
        const result = await storage.getExecution('nope');
        expect(result).toBeNull();
    });

    it('returns null for nonexistent state', async () => {
        const result = await storage.getJobState('nope');
        expect(result).toBeNull();
    });

    it('updates existing execution without duplicating', async () => {
        const ex: JobExecution = {
            id: 'e1',
            jobId: 'j1',
            jobName: 't',
            status: 'running',
            startedAt: new Date().toISOString(),
            logs: [],
            retryAttempt: 0,
        };
        await storage.saveExecution(ex);
        await storage.saveExecution({ ...ex, status: 'completed' });
        const result = await storage.getExecution('e1');
        expect(result!.status).toBe('completed');
        const { total } = await storage.getExecutions('j1');
        expect(total).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe('CliJobScheduler', () => {
    let storage: InMemoryJobStorageProvider;
    let scheduler: CliJobScheduler;

    beforeEach(() => {
        storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage);
    });

    afterEach(async () => {
        await scheduler.stop();
    });

    it('register returns an id', () => {
        const id = scheduler.register(new DummyJob(), { name: 'test', interval: '10s' });
        expect(scheduler.getRegistration(id)).toBeDefined();
    });

    it('register disabled sets stopped status', () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s', enabled: false });
        const reg = scheduler.getRegistration(id)!;
        expect(reg.status).toBe('stopped');
    });

    it('trigger executes job', async () => {
        const job = new DummyJob();
        const id = scheduler.register(job, { name: 't', interval: '999s' });
        (scheduler as any)._running = true;
        await scheduler.triggerAsync(id);
        await new Promise((r) => setTimeout(r, 100));
        expect(job.callCount).toBe(1);
        const { items, total } = await storage.getExecutions(id);
        expect(total).toBe(1);
        expect(items[0].status).toBe('completed');
    });

    it('trigger not found throws', async () => {
        (scheduler as any)._running = true;
        await expect(scheduler.triggerAsync('nonexistent')).rejects.toThrow();
    });

    it('trigger with skip overlap throws when already running', async () => {
        const job = new DummyJob({ sleep: 1000 });
        const id = scheduler.register(job, { name: 't', interval: '999s', overlapPolicy: 'skip' });
        (scheduler as any)._running = true;
        // Don't await — let the job run in background
        const firstTrigger = scheduler.triggerAsync(id);
        await new Promise((r) => setTimeout(r, 50));
        await expect(scheduler.triggerAsync(id)).rejects.toThrow();
        // Clean up: wait for first trigger to finish
        await firstTrigger;
    });

    it('pause and resume', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        (scheduler as any)._running = true;

        await scheduler.pauseAsync(id);
        expect(scheduler.getRegistration(id)!.status).toBe('paused');
        const state = await storage.getJobState(id);
        expect(state).not.toBeNull();
        expect(state!.status).toBe('paused');

        await scheduler.resumeAsync(id);
        expect(scheduler.getRegistration(id)!.status).toBe('active');
    });

    it('pause already paused throws', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        (scheduler as any)._running = true;
        await scheduler.pauseAsync(id);
        await expect(scheduler.pauseAsync(id)).rejects.toThrow();
    });

    it('resume not paused throws', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        (scheduler as any)._running = true;
        await expect(scheduler.resumeAsync(id)).rejects.toThrow();
    });

    it('stop job', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        (scheduler as any)._running = true;
        await scheduler.stopJobAsync(id);
        expect(scheduler.getRegistration(id)!.status).toBe('stopped');
    });

    it('cancel current when not running throws', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        (scheduler as any)._running = true;
        await expect(scheduler.cancelCurrentAsync(id)).rejects.toThrow();
    });

    it('cancel current aborts running job', async () => {
        const job = new SlowCancellableJob();
        const id = scheduler.register(job, { name: 't', interval: '999s' });
        (scheduler as any)._running = true;
        // Don't await — let the job run in background
        const triggerPromise = scheduler.triggerAsync(id);
        await new Promise((r) => setTimeout(r, 50));
        await scheduler.cancelCurrentAsync(id);
        await triggerPromise;
        const { items } = await storage.getExecutions(id);
        expect(items.length).toBeGreaterThanOrEqual(1);
        expect(items[0].status).toBe('cancelled');
    });

    it('failed job retries', async () => {
        const job = new DummyJob({ fail: true });
        const id = scheduler.register(job, { name: 't', interval: '999s', maxRetries: 2, retryDelay: '1s', retryStrategy: 'fixed' });
        (scheduler as any)._running = true;
        await scheduler.triggerAsync(id);
        await new Promise((r) => setTimeout(r, 3000));
        expect(job.callCount).toBe(3); // 1 original + 2 retries
        const { items, total } = await storage.getExecutions(id);
        expect(total).toBe(3);
        expect(items.every((e) => e.status === 'failed')).toBe(true);
    }, 10000);

    it('timeout cancels job', async () => {
        const job = new DummyJob({ sleep: 5000 });
        const id = scheduler.register(job, { name: 't', interval: '999s', timeout: '1s' });
        (scheduler as any)._running = true;
        // Don't await — triggerAsync awaits execution which would take 5s
        const triggerPromise = scheduler.triggerAsync(id);
        // Wait for timeout to fire (1s) plus some buffer
        await new Promise((r) => setTimeout(r, 1500));
        await triggerPromise;
        const { items } = await storage.getExecutions(id);
        expect(items.length).toBe(1);
        expect(items[0].status).toBe('timed_out');
    }, 10000);

    it('update options', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        (scheduler as any)._running = true;
        await scheduler.updateOptionsAsync(id, { description: 'updated', maxRetries: 3, overlapPolicy: 'queue' });
        const reg = scheduler.getRegistration(id)!;
        expect(reg.options.description).toBe('updated');
        expect(reg.options.maxRetries).toBe(3);
        expect(reg.options.overlapPolicy).toBe('queue');
    });

    it('update options with invalid cron throws', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        (scheduler as any)._running = true;
        await expect(scheduler.updateOptionsAsync(id, { schedule: 'not-a-cron' })).rejects.toThrow();
    });

    it('update options with both schedule and interval throws', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        (scheduler as any)._running = true;
        await expect(
            scheduler.updateOptionsAsync(id, { schedule: '* * * * *', interval: '10s' }),
        ).rejects.toThrow();
    });

    it('start and stop lifecycle', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '999s' });
        await scheduler.start();
        expect(scheduler.getRegistration(id)!.status).toBe('active');
        expect(scheduler.getRegistration(id)!.nextRunAt).toBeDefined();
        await scheduler.stop();
        const state = await storage.getJobState(id);
        expect(state).not.toBeNull();
    });

    it('start restores paused state', async () => {
        const id = scheduler.register(new DummyJob(), { name: 't', interval: '10s' });
        await storage.saveJobState(id, { status: 'paused', updatedAt: new Date().toISOString() });
        await scheduler.start();
        expect(scheduler.getRegistration(id)!.status).toBe('paused');
        await scheduler.stop();
    });
});

// ---------------------------------------------------------------------------
// Stable ids, interval rhythm, run on start, properties, discard, pruning
// ---------------------------------------------------------------------------

class PropsJob implements ICliJob {
    callCount = 0;
    async executeAsync(context: ICliJobExecutionContext): Promise<void> {
        this.callCount++;
        context.properties.calls = this.callCount;
    }
}

class DiscardingJob implements ICliJob {
    constructor(private readonly fail: boolean) {}
    async executeAsync(context: ICliJobExecutionContext): Promise<void> {
        context.discard();
        context.properties.seen = true;
        await Promise.resolve();
        if (this.fail) throw new Error('boom');
    }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CliJobScheduler ids and start', () => {
    let storage: InMemoryJobStorageProvider;
    let scheduler: CliJobScheduler;

    beforeEach(() => {
        storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage);
    });

    afterEach(async () => {
        await scheduler.stop();
    });

    it('ids are the set id, or the name numbered in order', () => {
        scheduler.register(new DummyJob(), { id: 'fetch-rates:bnr', name: 'BNR' });
        scheduler.register(new DummyJob(), { name: 'digest' });
        scheduler.register(new DummyJob(), { name: 'digest' });
        scheduler.register(new DummyJob(), {});

        expect([...scheduler.jobs.keys()]).toEqual(['fetch-rates:bnr', 'digest', 'digest-2', 'DummyJob']);
        expect(scheduler.get('DummyJob')!.name).toBe('DummyJob');
        expect(() => scheduler.register(new DummyJob(), { id: 'digest' })).toThrow(/already registered/);
        expect(() => scheduler.register(new DummyJob(), { id: ' ' })).toThrow(/empty/);
    });

    it('ids are URL-safe', () => {
        scheduler.register(new DummyJob(), { name: 'reports/daily' });

        expect([...scheduler.jobs.keys()]).toEqual(['reports-daily']);
        expect(() => scheduler.register(new DummyJob(), { id: 'a/b' })).toThrow(/may not contain/);
    });

    it('a job the code disables stays stopped whatever was saved', async () => {
        const lastRunAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
        await storage.saveJobState('nightly', { status: 'active', lastRunAt, updatedAt: '' });
        await storage.saveJobState('weekly', { status: 'stopped', updatedAt: '' });
        const nightly = new DummyJob();
        scheduler.register(nightly, { name: 'nightly', interval: '1h', enabled: false });
        scheduler.register(new DummyJob(), { name: 'weekly', interval: '1h' });

        await scheduler.start();
        await wait(100);

        expect(scheduler.jobs.get('nightly')!.status).toBe('stopped');
        expect(scheduler.jobs.get('nightly')!.lastRunAt).toBe(lastRunAt);
        expect(nightly.callCount).toBe(0);
        // A stop made at run time is kept
        expect(scheduler.jobs.get('weekly')!.status).toBe('stopped');
    });

    it('a run whose properties cannot be saved is saved without them', async () => {
        class RefusingStore extends InMemoryJobStorageProvider {
            override async saveExecution(execution: Parameters<InMemoryJobStorageProvider['saveExecution']>[0]): Promise<void> {
                if (execution.properties && Object.keys(execution.properties).length > 0) throw new Error('not serializable');
                return super.saveExecution(execution);
            }
        }
        const refusing = new RefusingStore();
        const s = new CliJobScheduler(refusing);
        const id = s.register(
            { executeAsync: async (ctx) => { ctx.properties.items = 3; } },
            { name: 'props' },
        );
        await s.start();
        try {
            await s.triggerAsync(id);
            await wait(100);

            const { items } = await refusing.getExecutions(id);
            expect(items[0].status).toBe('completed');
            expect(items[0].properties).toEqual({});
            expect(items[0].logs.some((l) => l.level === 'error' && l.message.includes('properties'))).toBe(true);
            expect(s.jobs.get(id)!.currentExecutionId).toBeUndefined();
        } finally {
            await s.stop();
        }
    });

    it('saved state is found again after a restart', async () => {
        await storage.saveJobState('nightly', { status: 'paused', updatedAt: new Date().toISOString() });
        scheduler.register(new DummyJob(), { name: 'nightly', interval: '1h' });

        await scheduler.start();

        expect(scheduler.jobs.get('nightly')!.status).toBe('paused');
    });

    it('an interval keeps its rhythm across restarts and an overdue job runs right away', async () => {
        const lastRun = Date.now() - 20 * 60_000;
        await storage.saveJobState('hourly', { status: 'active', lastRunAt: new Date(lastRun).toISOString(), updatedAt: '' });
        await storage.saveJobState('overdue', { status: 'active', lastRunAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), updatedAt: '' });
        const overdue = new DummyJob();
        scheduler.register(new DummyJob(), { name: 'hourly', interval: '1h' });
        scheduler.register(overdue, { name: 'overdue', interval: '1h' });

        await scheduler.start();
        await wait(150);

        expect(Math.abs(new Date(scheduler.jobs.get('hourly')!.nextRunAt!).getTime() - (lastRun + 3_600_000))).toBeLessThan(1000);
        expect(overdue.callCount).toBe(1);
        // Then every interval from that run on
        expect(new Date(scheduler.jobs.get('overdue')!.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    });

    it('resume keeps the rhythm of the last run', async () => {
        const lastRun = Date.now() - 10 * 60_000;
        await storage.saveJobState('hourly', { status: 'paused', lastRunAt: new Date(lastRun).toISOString(), updatedAt: '' });
        scheduler.register(new DummyJob(), { name: 'hourly', interval: '1h' });
        await scheduler.start();

        await scheduler.resumeAsync('hourly');

        expect(Math.abs(new Date(scheduler.jobs.get('hourly')!.nextRunAt!).getTime() - (lastRun + 3_600_000))).toBeLessThan(1000);
    });

    it('runOnStart runs on-demand jobs once, but not paused ones', async () => {
        const onDemand = new DummyJob();
        const hourly = new DummyJob({ sleep: 100 });
        const paused = new DummyJob();
        await storage.saveJobState('paused', { status: 'paused', updatedAt: '' });
        await storage.saveJobState('hourly', { status: 'active', lastRunAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), updatedAt: '' });
        scheduler.register(onDemand, { name: 'backfill', runOnStart: true });
        scheduler.register(hourly, { name: 'hourly', interval: '1h', runOnStart: true });
        scheduler.register(paused, { name: 'paused', runOnStart: true });

        await scheduler.start();
        await wait(400);

        expect(onDemand.callCount).toBe(1);
        // Overdue and run on start: still one run
        expect(hourly.callCount).toBe(1);
        expect(paused.callCount).toBe(0);
    });

    it("the job's properties are saved with the execution", async () => {
        const job = new PropsJob();
        scheduler.register(job, { name: 'props' });
        await scheduler.start();

        await scheduler.triggerAsync('props');

        const { items } = await storage.getExecutions('props');
        expect(items[0].properties).toEqual({ calls: 1 });
    });

    it('discard leaves a completed run out of the history but keeps failures', async () => {
        scheduler.register(new DiscardingJob(false), { name: 'quiet' });
        scheduler.register(new DiscardingJob(true), { name: 'broken', maxRetries: 0 });
        await scheduler.start();

        await scheduler.triggerAsync('quiet');
        await scheduler.triggerAsync('broken');

        expect((await storage.getExecutions('quiet')).total).toBe(0);
        expect(scheduler.jobs.get('quiet')!.lastRunAt).toBeDefined();
        const broken = await storage.getExecutions('broken');
        expect(broken.total).toBe(1);
        expect(broken.items[0]).toMatchObject({ status: 'failed', properties: { seen: true } });
    });

    it('queryExecutions merges the per-job listings of a storage without its own query', async () => {
        const plain: ICliJobStorageProvider = {
            saveExecution: (e) => storage.saveExecution(e),
            getExecutions: (id, o) => storage.getExecutions(id, o),
            getExecution: (id) => storage.getExecution(id),
            saveJobState: (id, s) => storage.saveJobState(id, s),
            getJobState: (id) => storage.getJobState(id),
            getAllJobStates: () => storage.getAllJobStates(),
        };
        const s = new CliJobScheduler(plain);
        const job = new PropsJob();
        s.register(job, { name: 'a' });
        s.register(job, { name: 'b' });
        await s.start();
        await s.triggerAsync('a');
        await wait(5);
        await s.triggerAsync('b');

        const all = await s.queryExecutions({});
        expect(all.total).toBe(2);
        expect(all.items.map((e) => e.jobId)).toEqual(['b', 'a']);
        expect((await s.queryExecutions({ jobIds: ['a'] })).items.map((e) => e.properties)).toEqual([{ calls: 1 }]);
        expect((await s.queryExecutions({ since: new Date(Date.now() + 86_400_000) })).total).toBe(0);
        expect((await s.queryExecutions({ limit: 1, offset: 1 })).items.map((e) => e.jobId)).toEqual(['a']);

        // The storage default needs job ids
        await expect(queryJobExecutions(plain, {})).rejects.toThrow(/not supported/);
        expect((await queryJobExecutions(plain, { jobIds: ['a', 'b'], status: 'COMPLETED' })).total).toBe(2);
        expect(await pruneJobExecutions(plain, new Date())).toBe(0);
        expect(await deleteJobExecution(plain, all.items[0].id)).toBe(false);
        await s.stop();
    });
});

describe('InMemoryJobStorageProvider prune, delete and query', () => {
    const execution = (id: string, jobId: string, startedAt: Date, status: JobExecution['status'] = 'completed'): JobExecution => ({
        id, jobId, jobName: jobId, status, startedAt: startedAt.toISOString(), logs: [], retryAttempt: 0,
    });

    it('prunes old executions', async () => {
        const storage = new InMemoryJobStorageProvider();
        await storage.saveExecution(execution('old', 'a', new Date(Date.now() - 40 * 86_400_000)));
        await storage.saveExecution(execution('new', 'a', new Date()));

        expect(await storage.prune(new Date(Date.now() - 30 * 86_400_000))).toBe(1);
        expect((await storage.getExecutions('a')).total).toBe(1);
        expect(await storage.getExecution('old')).toBeNull();
    });

    it('deletes an execution', async () => {
        const storage = new InMemoryJobStorageProvider();
        await storage.saveExecution(execution('x', 'a', new Date()));

        expect(await storage.deleteExecution('x')).toBe(true);
        expect(await storage.deleteExecution('x')).toBe(false);
        expect((await storage.getExecutions('a')).total).toBe(0);
    });

    it('queries executions across jobs, newest first', async () => {
        const storage = new InMemoryJobStorageProvider();
        await storage.saveExecution(execution('1', 'a', new Date(1000)));
        await storage.saveExecution(execution('2', 'b', new Date(2000), 'failed'));
        await storage.saveExecution(execution('3', 'c', new Date(3000)));

        expect((await storage.queryExecutions({})).items.map((e) => e.id)).toEqual(['3', '2', '1']);
        expect((await storage.queryExecutions({ jobIds: ['a', 'b'] })).items.map((e) => e.id)).toEqual(['2', '1']);
        expect((await storage.queryExecutions({ status: 'Failed' })).items.map((e) => e.id)).toEqual(['2']);
        expect((await storage.queryExecutions({ since: new Date(2000) })).total).toBe(2);
        expect(await storage.queryExecutions({ limit: 1, offset: 1 })).toMatchObject({ total: 3, items: [{ id: '2' }] });
    });
});
