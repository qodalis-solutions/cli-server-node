import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    ICliJob,
    ICliJobExecutionContext,
    CliJobOptions,
    JobExecution,
    JobState,
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
