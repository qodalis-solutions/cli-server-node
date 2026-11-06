/**
 * Job concurrency (web-cli docs/superpowers/specs/2026-11-06-job-concurrency-design.md):
 * maxConcurrentRuns, slots held across retries, coalescing queue, cancel of the oldest run,
 * run on start, cron early ticks and interrupted runs. Jobs are gated by hand and time is
 * faked where timers matter, so nothing depends on real timing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CliEvent, ICliJob, ICliJobExecutionContext, JobExecution } from '@qodalis/cli-server-abstractions';
import { InMemoryJobStorageProvider } from '../../plugins/jobs/in-memory-job-storage-provider';
import { CliJobScheduler, INTERRUPTED_RUN_ERROR, JobError, nextCronOccurrence } from '../../plugins/jobs/cli-job-scheduler';
import { createCliJobsController } from '../../plugins/jobs/cli-jobs-controller';
import { CliEventBus } from '../services/cli-event-bus';

/** A job whose runs wait until released (or aborted); counts concurrent and total runs. */
class GatedJob implements ICliJob {
    started = 0;
    active = 0;
    maxActive = 0;
    /** Failures to throw on the next attempts, one per attempt. */
    failNext = 0;
    private readonly gates: Array<() => void> = [];

    async executeAsync(_context: ICliJobExecutionContext, signal: AbortSignal): Promise<void> {
        this.started++;
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        try {
            if (this.failNext > 0) {
                this.failNext--;
                throw new Error('attempt failed');
            }
            await new Promise<void>((resolve) => {
                this.gates.push(resolve);
                signal.addEventListener('abort', () => {
                    const i = this.gates.indexOf(resolve);
                    if (i >= 0) this.gates.splice(i, 1);
                    resolve();
                }, { once: true });
            });
        } finally {
            this.active--;
        }
    }

    /** Lets the oldest waiting run finish. */
    releaseOne(): void {
        this.gates.shift()?.();
    }

    releaseAll(): void {
        while (this.gates.length) this.releaseOne();
    }

    get waiting(): number {
        return this.gates.length;
    }
}

/** Lets pending promise callbacks (storage writes, run starts) run. */
const flush = async (times = 5) => {
    for (let i = 0; i < times; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
};

const waitUntil = async (cond: () => boolean, tries = 200) => {
    for (let i = 0; i < tries && !cond(); i++) await flush(1);
    if (!cond()) throw new Error('condition not reached');
};

async function executions(storage: InMemoryJobStorageProvider, jobId: string): Promise<JobExecution[]> {
    return (await storage.getExecutions(jobId, { limit: 100, offset: 0 })).items;
}

describe('maxConcurrentRuns', () => {
    let storage: InMemoryJobStorageProvider;
    let scheduler: CliJobScheduler;
    let job: GatedJob;

    beforeEach(() => {
        storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage);
        job = new GatedJob();
    });
    afterEach(async () => {
        job.releaseAll();
        await scheduler.stop();
    });

    for (const n of [1, 2]) {
        it(`N = ${n}: parallel triggers never exceed ${n}`, async () => {
            scheduler.register(job, { id: 'j', maxConcurrentRuns: n });
            const results = Array.from({ length: 5 }, () => scheduler.triggerAsync('j').then(() => 'ran', (e: JobError) => e.code));
            await waitUntil(() => job.waiting === n);
            expect(job.active).toBe(n);
            expect(scheduler.get('j')!.runningExecutionIds).toHaveLength(n);
            job.releaseAll();
            const outcomes = await Promise.all(results);
            expect(outcomes.filter((o) => o === 'ran')).toHaveLength(n);
            expect(outcomes.filter((o) => o === 'JOB_ALREADY_RUNNING')).toHaveLength(5 - n);
            expect(job.maxActive).toBe(n);
        });
    }

    it('N = 2: timer ticks and triggers together never exceed 2', async () => {
        vi.useFakeTimers();
        try {
            scheduler.register(job, { id: 'j', interval: '1s', maxConcurrentRuns: 2 });
            await scheduler.start();
            const triggers = [scheduler.triggerAsync('j').catch(() => undefined), scheduler.triggerAsync('j').catch(() => undefined)];
            for (let i = 0; i < 5; i++) {
                await vi.advanceTimersByTimeAsync(1000);
                scheduler.triggerAsync('j').catch(() => undefined);
            }
            expect(job.maxActive).toBe(2);
            expect(job.started).toBe(2);
            job.releaseAll();
            await Promise.all(triggers);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a retry delay keeps the slot: skip refuses a run during the delay', async () => {
        vi.useFakeTimers();
        try {
            job.failNext = 1;
            scheduler.register(job, { id: 'j', interval: '1s', maxRetries: 1, retryDelay: '10s', retryStrategy: 'fixed', overlapPolicy: 'skip' });
            await scheduler.start();
            await vi.advanceTimersByTimeAsync(1000); // first attempt fails, the retry waits 10 s
            expect(job.started).toBe(1);
            expect(scheduler.get('j')!.runningExecutionIds).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(5000); // five ticks during the delay
            await expect(scheduler.triggerAsync('j')).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });
            expect(job.started).toBe(1);
            await vi.advanceTimersByTimeAsync(5000); // the retry
            expect(job.started).toBe(2);
            expect(job.waiting).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a retry delay keeps the slot: queue queues one run for after the retry', async () => {
        vi.useFakeTimers();
        try {
            job.failNext = 1;
            scheduler.register(job, { id: 'j', maxRetries: 1, retryDelay: '10s', retryStrategy: 'fixed', overlapPolicy: 'queue' });
            const first = scheduler.triggerAsync('j');
            await vi.advanceTimersByTimeAsync(0);
            expect(job.started).toBe(1); // failed, in its retry delay
            expect(await scheduler.triggerAsync('j')).toEqual({ queued: true });
            expect(scheduler.get('j')!.queued).toBe(true);
            expect(job.started).toBe(1);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(job.started).toBe(2); // the retry, the queued run still waits
            job.releaseOne();
            await first;
            await vi.advanceTimersByTimeAsync(0);
            expect(job.started).toBe(3); // the queued run
            expect(scheduler.get('j')!.queued).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('the queue coalesces: three due runs while full make exactly one extra run', async () => {
        scheduler.register(job, { id: 'j', overlapPolicy: 'queue' });
        const first = scheduler.triggerAsync('j');
        await waitUntil(() => job.waiting === 1);
        for (let i = 0; i < 3; i++) expect(await scheduler.triggerAsync('j')).toEqual({ queued: true });
        expect(scheduler.get('j')!.queued).toBe(true);
        job.releaseOne();
        await first;
        await waitUntil(() => job.waiting === 1);
        expect(job.started).toBe(2);
        expect(scheduler.get('j')!.queued).toBe(false);
        job.releaseOne();
        await waitUntil(() => job.active === 0);
        await flush();
        expect(job.started).toBe(2);
        expect(job.maxActive).toBe(1);
    });

    it('cancel policy cancels the oldest run', async () => {
        scheduler.register(job, { id: 'j', maxConcurrentRuns: 2, overlapPolicy: 'cancel' });
        const a = scheduler.triggerAsync('j');
        await waitUntil(() => job.waiting === 1);
        const b = scheduler.triggerAsync('j');
        await waitUntil(() => job.waiting === 2);
        const [idA, idB] = scheduler.get('j')!.runningExecutionIds;
        const c = scheduler.triggerAsync('j');
        await a;
        await waitUntil(() => job.waiting === 2);
        const running = scheduler.get('j')!.runningExecutionIds;
        expect(running).toHaveLength(2);
        expect(running[0]).toBe(idB);
        expect(running).not.toContain(idA);
        expect((await storage.getExecution(idA))!.status).toBe('cancelled');
        expect(scheduler.get('j')!.currentExecutionId).toBe(running[1]);
        job.releaseAll();
        await Promise.all([b, c]);
    });

    it('cancel cancels every running run and drops a queued one', async () => {
        scheduler.register(job, { id: 'j', maxConcurrentRuns: 2, overlapPolicy: 'queue' });
        const runs = [scheduler.triggerAsync('j'), scheduler.triggerAsync('j')];
        await waitUntil(() => job.waiting === 2);
        expect(await scheduler.triggerAsync('j')).toEqual({ queued: true });
        await scheduler.cancelCurrentAsync('j');
        await Promise.all(runs);
        await flush();
        expect(job.started).toBe(2);
        const dto = scheduler.get('j')!;
        expect(dto.runningExecutionIds).toEqual([]);
        expect(dto.queued).toBe(false);
        expect((await executions(storage, 'j')).map((e) => e.status)).toEqual(['cancelled', 'cancelled']);
    });

    it('lowering the limit cancels nothing; new runs start only below it', async () => {
        scheduler.register(job, { id: 'j', maxConcurrentRuns: 2 });
        const runs = [scheduler.triggerAsync('j'), scheduler.triggerAsync('j')];
        await waitUntil(() => job.waiting === 2);
        await scheduler.updateOptionsAsync('j', { maxConcurrentRuns: 1 });
        expect(job.active).toBe(2);
        job.releaseOne();
        await runs[0];
        await expect(scheduler.triggerAsync('j')).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });
        job.releaseOne();
        await runs[1];
        const third = scheduler.triggerAsync('j');
        await waitUntil(() => job.waiting === 1);
        job.releaseOne();
        await third;
        expect(job.started).toBe(3);
    });

    it('raising the limit starts a queued run', async () => {
        scheduler.register(job, { id: 'j', overlapPolicy: 'queue' });
        scheduler.triggerAsync('j');
        await waitUntil(() => job.waiting === 1);
        await scheduler.triggerAsync('j');
        await scheduler.updateOptionsAsync('j', { maxConcurrentRuns: 2 });
        await waitUntil(() => job.waiting === 2);
        expect(scheduler.get('j')!.queued).toBe(false);
    });

    it('registering an invalid maxConcurrentRuns throws', () => {
        for (const bad of [0, -1, 1.5, NaN]) {
            expect(() => scheduler.register(job, { id: `bad-${bad}`, maxConcurrentRuns: bad })).toThrow(/maxConcurrentRuns/);
        }
    });
});

describe('cancel versus timeout', () => {
    it('a job with a timeout cancelled by hand reports job:cancelled', async () => {
        const storage = new InMemoryJobStorageProvider();
        const scheduler = new CliJobScheduler(storage);
        const bus = new CliEventBus();
        const events: CliEvent[] = [];
        bus.subscribe('job:*', (e) => void events.push(e));
        scheduler.setEventBus(bus);
        const job = new GatedJob();
        scheduler.register(job, { id: 'j', timeout: '1h' });
        const run = scheduler.triggerAsync('j');
        await waitUntil(() => job.waiting === 1);
        await scheduler.cancelCurrentAsync('j');
        await run;
        expect(events.map((e) => e.type)).toEqual(['job:started', 'job:cancelled']);
        expect((await executions(storage, 'j'))[0].status).toBe('cancelled');
        await scheduler.stop();
    });

    it('a timeout still reports job:timed_out', async () => {
        vi.useFakeTimers();
        try {
            const storage = new InMemoryJobStorageProvider();
            const scheduler = new CliJobScheduler(storage);
            const job = new GatedJob();
            scheduler.register(job, { id: 'j', timeout: '1s', maxRetries: 0 });
            const run = scheduler.triggerAsync('j');
            await vi.advanceTimersByTimeAsync(1000);
            await run;
            expect((await executions(storage, 'j'))[0].status).toBe('timed_out');
            await scheduler.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('run on start', () => {
    const NOW = new Date('2026-11-06T11:10:00.000Z');
    let storage: InMemoryJobStorageProvider;
    let scheduler: CliJobScheduler;
    let job: GatedJob;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage);
        job = new GatedJob();
    });
    afterEach(async () => {
        job.releaseAll();
        await scheduler.stop();
        vi.useRealTimers();
    });

    const lastRun = (iso: string) => storage.saveJobState('j', { status: 'active', lastRunAt: iso, updatedAt: iso });

    it('interval: not run when the last run is recent', async () => {
        await lastRun('2026-11-06T11:00:00.000Z');
        scheduler.register(job, { id: 'j', interval: '1h', runOnStart: true });
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(10);
        expect(job.started).toBe(0);
        expect(scheduler.get('j')!.nextRunAt).toBe('2026-11-06T12:00:00.000Z');
    });

    it('interval: run when its next run is due, or it never ran', async () => {
        await lastRun('2026-11-06T10:00:00.000Z');
        scheduler.register(job, { id: 'j', interval: '1h', runOnStart: true });
        const never = new GatedJob();
        scheduler.register(never, { id: 'never', interval: '1h', runOnStart: true });
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(10);
        expect(job.started).toBe(1);
        expect(never.started).toBe(1);
        never.releaseAll();
    });

    it('cron: run when it missed an occurrence, or never ran; not when it ran since the last one', async () => {
        await storage.saveJobState('missed', { status: 'active', lastRunAt: '2026-11-06T10:30:00.000Z', updatedAt: '' });
        await storage.saveJobState('recent', { status: 'active', lastRunAt: '2026-11-06T11:00:00.000Z', updatedAt: '' });
        const missed = new GatedJob();
        const recent = new GatedJob();
        const never = new GatedJob();
        scheduler.register(missed, { id: 'missed', schedule: '0 * * * *', runOnStart: true });
        scheduler.register(recent, { id: 'recent', schedule: '0 * * * *', runOnStart: true });
        scheduler.register(never, { id: 'never', schedule: '0 * * * *', runOnStart: true });
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(10);
        expect([missed.started, recent.started, never.started]).toEqual([1, 0, 1]);
        for (const j of [missed, recent, never]) j.releaseAll();
    });

    it('a job without a schedule runs on every start', async () => {
        await lastRun('2026-11-06T11:09:59.000Z');
        scheduler.register(job, { id: 'j', runOnStart: true });
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(10);
        expect(job.started).toBe(1);
    });

    it('goes through the slots: a full job with skip is not started twice', async () => {
        scheduler.register(job, { id: 'j', runOnStart: true });
        const running = scheduler.triggerAsync('j');
        await vi.advanceTimersByTimeAsync(0);
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(10);
        expect(job.started).toBe(1);
        job.releaseAll();
        await running;
    });
});

describe('cron', () => {
    it('the next occurrence is computed from the fired one', () => {
        const fired = new Date('2026-11-06T10:01:00.000Z');
        const early = fired.getTime() - 3;
        expect(nextCronOccurrence('* * * * *', fired, early).toISOString()).toBe('2026-11-06T10:02:00.000Z');
        // Already past (busy process, clock jump): the next one after now
        expect(nextCronOccurrence('* * * * *', fired, Date.parse('2026-11-06T10:05:30.000Z')).toISOString()).toBe('2026-11-06T10:06:00.000Z');
        expect(nextCronOccurrence('* * * * *', undefined, Date.parse('2026-11-06T10:00:30.000Z')).toISOString()).toBe('2026-11-06T10:01:00.000Z');
    });

    it('a tick that fires early does not run the occurrence twice', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-06T10:00:30.000Z'));
        const storage = new InMemoryJobStorageProvider();
        const scheduler = new CliJobScheduler(storage);
        const job = new GatedJob();
        scheduler.register(job, { id: 'j', schedule: '* * * * *' });
        await scheduler.start();
        // From now on every timer fires 3 ms "early": the wall clock lags the timers
        const fakeNow = Date.now.bind(Date);
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow() - 3);
        try {
            await vi.advanceTimersByTimeAsync(30_000); // 10:01:00
            job.releaseAll();
            await vi.advanceTimersByTimeAsync(59_000); // until 10:01:59
            expect(job.started).toBe(1);
            expect(scheduler.get('j')!.nextRunAt).toBe('2026-11-06T10:02:00.000Z');
            await vi.advanceTimersByTimeAsync(1_010); // 10:02:00 (+ the 3 ms lag)
            expect(job.started).toBe(2);
        } finally {
            spy.mockRestore();
            job.releaseAll();
            await scheduler.stop();
            vi.useRealTimers();
        }
    });
});

describe('interrupted runs', () => {
    it('are finished as cancelled on start, without events', async () => {
        const storage = new InMemoryJobStorageProvider();
        const left: JobExecution = {
            id: 'e-left',
            jobId: 'j',
            jobName: 'j',
            status: 'running',
            startedAt: '2026-11-06T09:00:00.000Z',
            logs: [],
            retryAttempt: 0,
        };
        await storage.saveExecution(left);
        await storage.saveExecution({ ...left, id: 'e-done', status: 'completed', completedAt: '2026-11-06T08:00:01.000Z', duration: 1000 });
        await storage.saveExecution({ ...left, id: 'e-other', jobId: 'unregistered' });

        const scheduler = new CliJobScheduler(storage);
        const bus = new CliEventBus();
        const events: CliEvent[] = [];
        bus.subscribe('*', (e) => void events.push(e));
        scheduler.setEventBus(bus);
        scheduler.register(new GatedJob(), { id: 'j' });
        await scheduler.start();

        expect(await storage.getExecution('e-left')).toMatchObject({
            status: 'cancelled',
            error: INTERRUPTED_RUN_ERROR,
            completedAt: '2026-11-06T09:00:00.000Z',
            duration: 0,
        });
        expect((await storage.getExecution('e-done'))!.status).toBe('completed');
        expect((await storage.getExecution('e-other'))!.status).toBe('running');
        expect(events).toEqual([]);
        await scheduler.stop();
    });
});

describe('jobs API', () => {
    let storage: InMemoryJobStorageProvider;
    let scheduler: CliJobScheduler;
    let app: express.Express;
    let job: GatedJob;

    beforeEach(() => {
        storage = new InMemoryJobStorageProvider();
        scheduler = new CliJobScheduler(storage);
        job = new GatedJob();
        scheduler.register(job, { id: 'j', overlapPolicy: 'queue' });
        app = express();
        app.use(express.json());
        app.use('/jobs', createCliJobsController(scheduler, storage));
    });
    afterEach(async () => {
        job.releaseAll();
        await scheduler.stop();
    });

    it('job info has maxConcurrentRuns, runningExecutionIds and queued', async () => {
        const idle = await request(app).get('/jobs/j').expect(200);
        expect(idle.body).toMatchObject({ maxConcurrentRuns: 1, runningExecutionIds: [], queued: false });
        expect(idle.body.currentExecutionId).toBeUndefined();

        const run = scheduler.triggerAsync('j');
        await waitUntil(() => job.waiting === 1);
        const queued = await request(app).post('/jobs/j/trigger').expect(202);
        expect(queued.body).toEqual({ ok: true, queued: true });

        const busy = await request(app).get('/jobs').expect(200);
        const info = busy.body.find((j: { id: string }) => j.id === 'j');
        expect(info.runningExecutionIds).toHaveLength(1);
        expect(info.currentExecutionId).toBe(info.runningExecutionIds[0]);
        expect(info.queued).toBe(true);
        job.releaseAll();
        await run;
    });

    it('PUT accepts maxConcurrentRuns and validates it', async () => {
        const res = await request(app).put('/jobs/j').send({ maxConcurrentRuns: 3 }).expect(200);
        expect(res.body.maxConcurrentRuns).toBe(3);
        for (const bad of [0, -2, 1.5, '2', null, true]) {
            const r = await request(app).put('/jobs/j').send({ maxConcurrentRuns: bad });
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('INVALID_MAX_CONCURRENT_RUNS');
        }
        expect((await request(app).get('/jobs/j')).body.maxConcurrentRuns).toBe(3);
    });
});
