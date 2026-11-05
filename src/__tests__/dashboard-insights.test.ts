/**
 * Dashboard insights (1.0.0-beta.19): jobs statistics, log histogram, status
 * history, command usage counters and the audit time filter.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    ICliJob,
    ICliJobExecutionContext,
    ICliJobStorageProvider,
    JobExecution,
    JobExecutionStatus,
} from '@qodalis/cli-server-abstractions';
import { CliAuditBuilder, InMemoryAuditStore } from '@qodalis/cli-server-plugin-audit';
import { CliJobsBuilder } from '../../plugins/jobs/cli-jobs-builder';
import { InMemoryJobStorageProvider } from '../../plugins/jobs/in-memory-job-storage-provider';
import { jobRunOutcome, summarize, resolveStatsRange } from '../../plugins/jobs/cli-jobs-stats';
import { CliAdminBuilder, CliAdminPluginResult, LogRingBuffer, StatusSampler } from '../../plugins/admin';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { CliEventSocketManager } from '../services/cli-event-socket-manager';
import { CliCommandExecutorService } from '../services/cli-command-executor-service';
import { CliCommandUsageStats } from '../services/cli-command-usage-stats';
import { CliBuilder } from '../extensions/cli-builder';
import { createCliController } from '../controllers/cli-controller';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { CliUsersBuilder } from '../../plugins/users/index';
import { auth, login } from './users-test-helpers';

const disposables: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Jobs statistics
// ---------------------------------------------------------------------------

class NoopJob implements ICliJob {
    async executeAsync(_context: ICliJobExecutionContext): Promise<void> {}
}

const SINCE = '2026-11-04T00:00:00.000Z';
const UNTIL = '2026-11-05T00:00:00.000Z';
const HOUR = 3_600_000;

let execSeq = 0;
function run(jobId: string, startedAt: string, status: JobExecutionStatus | string, duration?: number, jobName = jobId): JobExecution {
    return {
        id: `exec-${++execSeq}`,
        jobId,
        jobName,
        status: status as JobExecutionStatus,
        startedAt,
        duration,
        logs: [],
        retryAttempt: 0,
    };
}

function at(hours: number, minutes = 0): string {
    return new Date(Date.parse(SINCE) + hours * HOUR + minutes * 60_000).toISOString();
}

/** A store with only per-job listings (no `queryExecutions`): the merged path. */
class PerJobOnlyStorage implements ICliJobStorageProvider {
    readonly inner = new InMemoryJobStorageProvider();
    saveExecution(e: JobExecution) { return this.inner.saveExecution(e); }
    getExecutions(jobId: string, options?: { limit?: number; offset?: number; status?: JobExecutionStatus }) {
        return this.inner.getExecutions(jobId, options);
    }
    getExecution(id: string) { return this.inner.getExecution(id); }
    saveJobState(jobId: string, state: any) { return this.inner.saveJobState(jobId, state); }
    getJobState(jobId: string) { return this.inner.getJobState(jobId); }
    getAllJobStates() { return this.inner.getAllJobStates(); }
}

/** A store that answers at most 100 runs per query (like a remote API) and counts the calls. */
class CappedQueryStorage extends InMemoryJobStorageProvider {
    calls = 0;
    override async queryExecutions(query: any) {
        this.calls++;
        return super.queryExecutions({ ...query, limit: Math.min(query.limit ?? 20, 100) });
    }
}

function jobsApp(storage: ICliJobStorageProvider = new InMemoryJobStorageProvider()) {
    const plugin = new CliJobsBuilder()
        .setStorageProvider(storage)
        .addJob(new NoopJob(), { name: 'fetch-rates', group: 'Rates', interval: '999s' })
        .addJob(new NoopJob(), { name: 'cleanup', interval: '999s' })
        .addJob(new NoopJob(), { name: 'stats', interval: '999s' })
        .build();
    const app = express();
    app.use(express.json());
    app.use(plugin.prefix, plugin.router);
    const ids = Object.fromEntries(plugin.scheduler.getAll().map((j) => [j.name, j.id]));
    return { app, plugin, storage, ids };
}

describe('jobs stats: outcome and summary', () => {
    it('maps statuses to outcomes', () => {
        expect(jobRunOutcome('completed')).toBe('succeeded');
        expect(jobRunOutcome('Succeeded')).toBe('succeeded');
        for (const s of ['failed', 'error', 'timed_out', 'TimedOut']) expect(jobRunOutcome(s)).toBe('failed');
        for (const s of ['running', 'pending']) expect(jobRunOutcome(s)).toBe('running');
        for (const s of ['cancelled', 'skipped', '', undefined]) expect(jobRunOutcome(s as any)).toBe('cancelled');
    });

    it('computes p95 by nearest rank and ignores running runs and runs without a duration', () => {
        const runs = Array.from({ length: 20 }, (_, i) => run('j', at(1), 'completed', (i + 1) * 100));
        runs.push(run('j', at(2), 'running', 999_999));
        runs.push(run('j', at(2), 'failed'));
        const s = summarize(runs);
        // sorted 100..2000, n=20: ceil(0.95*20)-1 = 18 -> 1900
        expect(s.p95Duration).toBe(1900);
        expect(s.maxDuration).toBe(2000);
        expect(s.avgDuration).toBe(1050);
        expect(s.total).toBe(22);
        expect(s.running).toBe(1);
        expect(s.successRate).toBe(Math.round((20 / 21) * 1000) / 1000);
        expect(s.lastFailureAt).toBe(at(2));
    });

    it('answers nulls without durations or decided runs', () => {
        const s = summarize([run('j', at(1), 'running'), run('j', at(1), 'cancelled')]);
        expect(s).toMatchObject({ successRate: null, avgDuration: null, p95Duration: null, maxDuration: null, lastFailureAt: null });
    });

    it('clamps buckets and defaults the range to the last 24 hours', () => {
        const now = new Date('2026-11-05T21:00:00Z');
        expect(resolveStatsRange(undefined, undefined, undefined, now)).toMatchObject({
            since: new Date('2026-11-04T21:00:00Z'),
            until: now,
            buckets: 24,
            bucketMs: HOUR,
        });
        expect(resolveStatsRange(undefined, undefined, '0', now).buckets).toBe(1);
        expect(resolveStatsRange(undefined, undefined, '-5', now).buckets).toBe(1);
        expect(resolveStatsRange(undefined, undefined, '5000', now).buckets).toBe(200);
        expect(resolveStatsRange(undefined, undefined, 'abc', now).buckets).toBe(24);
    });
});

describe('GET /api/v1/qcli/jobs/stats', () => {
    it('buckets runs, totals them and lists jobs with runs, sorted by id', async () => {
        const { app, storage, ids } = jobsApp();
        const fetch = ids['fetch-rates'];
        const cleanup = ids['cleanup'];
        await storage.saveExecution(run(fetch, at(0, 5), 'completed', 1000, 'Fetch rates'));
        await storage.saveExecution(run(fetch, at(0, 30), 'failed', 3000, 'Fetch rates'));
        await storage.saveExecution(run(fetch, at(5), 'timed_out', 5000, 'Fetch rates'));
        await storage.saveExecution(run(fetch, at(23, 59), 'running', undefined, 'Fetch rates'));
        await storage.saveExecution(run(cleanup, at(5, 10), 'cancelled', 200));
        // Outside the range: before since and at until (exclusive)
        await storage.saveExecution(run(fetch, '2026-11-03T23:59:59.000Z', 'completed', 10));
        await storage.saveExecution(run(fetch, UNTIL, 'completed', 10));

        const res = await request(app).get(`/api/v1/qcli/jobs/stats?since=${SINCE}&until=${UNTIL}&buckets=24`).expect(200);
        expect(res.body.since).toBe(SINCE);
        expect(res.body.until).toBe(UNTIL);
        expect(res.body.bucketMs).toBe(HOUR);
        expect(res.body.buckets).toHaveLength(24);
        expect(res.body.buckets[0]).toEqual({ start: SINCE, succeeded: 1, failed: 1, cancelled: 0, running: 0 });
        expect(res.body.buckets[5]).toMatchObject({ start: at(5), failed: 1, cancelled: 1 });
        expect(res.body.buckets[23]).toMatchObject({ running: 1 });
        expect(res.body.totals).toEqual({
            total: 5,
            succeeded: 1,
            failed: 2,
            cancelled: 1,
            running: 1,
            successRate: 0.333,
            avgDuration: 2300,
            p95Duration: 5000,
            maxDuration: 5000,
            lastFailureAt: at(5),
        });
        expect(res.body.jobs.map((j: any) => j.jobId)).toEqual([cleanup, fetch].sort());
        const fetchStats = res.body.jobs.find((j: any) => j.jobId === fetch);
        expect(fetchStats).toMatchObject({ jobName: 'Fetch rates', total: 4, succeeded: 1, failed: 2, running: 1, p95Duration: 5000 });
        expect(fetchStats.recent.map((r: any) => r.status)).toEqual(['running', 'timed_out', 'failed', 'completed']);
        expect(fetchStats.recent[0]).toEqual({ status: 'running', startedAt: at(23, 59), duration: null });
    });

    it('keeps at most 12 recent runs per job, newest first', async () => {
        const { app, storage, ids } = jobsApp();
        for (let i = 0; i < 20; i++) await storage.saveExecution(run(ids.cleanup, at(i), 'completed', i));
        const res = await request(app).get(`/api/v1/qcli/jobs/stats?since=${SINCE}&until=${UNTIL}`).expect(200);
        const recent = res.body.jobs[0].recent;
        expect(recent).toHaveLength(12);
        expect(recent[0].startedAt).toBe(at(19));
        expect(recent[11].startedAt).toBe(at(8));
    });

    it('answers an empty range with zero buckets, null rates and no jobs', async () => {
        const { app } = jobsApp();
        const res = await request(app).get(`/api/v1/qcli/jobs/stats?since=${SINCE}&until=${UNTIL}&buckets=4`).expect(200);
        expect(res.body.bucketMs).toBe(6 * HOUR);
        expect(res.body.buckets).toHaveLength(4);
        expect(res.body.buckets.every((b: any) => b.succeeded + b.failed + b.cancelled + b.running === 0)).toBe(true);
        expect(res.body.totals).toMatchObject({ total: 0, successRate: null, avgDuration: null, lastFailureAt: null });
        expect(res.body.jobs).toEqual([]);
    });

    it('filters by job (repeatable or comma-separated) and group; an empty group gives empty stats', async () => {
        const { app, storage, ids } = jobsApp();
        await storage.saveExecution(run(ids['fetch-rates'], at(1), 'completed', 10));
        await storage.saveExecution(run(ids.cleanup, at(1), 'completed', 10));
        await storage.saveExecution(run(ids.stats, at(1), 'completed', 10));
        const base = `/api/v1/qcli/jobs/stats?since=${SINCE}&until=${UNTIL}`;

        let res = await request(app).get(`${base}&job=${ids.cleanup},${ids.stats}`).expect(200);
        expect(res.body.totals.total).toBe(2);
        res = await request(app).get(`${base}&job=${ids.cleanup}&job=${ids['fetch-rates']}`).expect(200);
        expect(res.body.totals.total).toBe(2);
        res = await request(app).get(`${base}&group=rates`).expect(200);
        expect(res.body.jobs.map((j: any) => j.jobId)).toEqual([ids['fetch-rates']]);
        res = await request(app).get(`${base}&group=nope`).expect(200);
        expect(res.body.totals.total).toBe(0);
        expect(res.body.jobs).toEqual([]);
    });

    it('answers 400 for a bad time or an empty range', async () => {
        const { app } = jobsApp();
        let res = await request(app).get('/api/v1/qcli/jobs/stats?since=yesterday').expect(400);
        expect(res.body.error).toMatch(/since/);
        await request(app).get('/api/v1/qcli/jobs/stats?until=2026-13-45T00:00:00Z').expect(400);
        res = await request(app).get(`/api/v1/qcli/jobs/stats?since=${UNTIL}&until=${SINCE}`).expect(400);
        expect(res.body.error).toBeDefined();
    });

    it('reads a time without an offset as UTC', async () => {
        const { app } = jobsApp();
        const res = await request(app).get('/api/v1/qcli/jobs/stats?since=2026-11-04T00:00:00&until=2026-11-05T00:00').expect(200);
        expect(res.body.since).toBe(SINCE);
        expect(res.body.until).toBe(UNTIL);
    });

    it('is not shadowed by /:id (a job named "stats" stays reachable by its own id elsewhere)', async () => {
        const { app, ids } = jobsApp();
        const res = await request(app).get('/api/v1/qcli/jobs/stats').expect(200);
        expect(res.body).toHaveProperty('buckets');
        expect(res.body).toHaveProperty('totals');
        expect(ids.stats).toBeDefined();
    });

    it('pages through every run of a store that caps its pages (no fixed cap)', async () => {
        const storage = new CappedQueryStorage();
        const { app, ids } = jobsApp(storage);
        for (let i = 0; i < 1234; i++) await storage.saveExecution(run(ids.cleanup, at(i % 24, i % 60), 'completed', 5));
        const res = await request(app).get(`/api/v1/qcli/jobs/stats?since=${SINCE}&until=${UNTIL}`).expect(200);
        expect(res.body.totals.total).toBe(1234);
        expect(storage.calls).toBeGreaterThan(12);
    });

    it('works with a store without queryExecutions (per-job listings merged)', async () => {
        const storage = new PerJobOnlyStorage();
        const { app, ids } = jobsApp(storage);
        for (let i = 0; i < 700; i++) await storage.saveExecution(run(ids['fetch-rates'], at(i % 24), i % 7 === 0 ? 'failed' : 'completed', 5));
        await storage.saveExecution(run(ids.cleanup, at(3), 'completed', 5));
        const res = await request(app).get(`/api/v1/qcli/jobs/stats?since=${SINCE}&until=${UNTIL}`).expect(200);
        expect(res.body.totals.total).toBe(701);
        expect(res.body.totals.failed).toBe(100);
        expect(res.body.jobs).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// 2 + 3. Admin plugin: log histogram and status history
// ---------------------------------------------------------------------------

function adminApp(): { app: express.Express; admin: CliAdminPluginResult; token: () => Promise<string> } {
    const registry = new CliCommandRegistry();
    const builder = new CliBuilder(registry);
    const eventSocketManager = new CliEventSocketManager();
    const admin = new CliAdminBuilder()
        .setCredentials('admin', 'pass')
        .setJwtSecret('insights-secret')
        .build({ registry, eventSocketManager, builder, broadcastFn: () => {} });
    disposables.push(() => {
        admin.dispose();
        eventSocketManager.dispose();
    });
    const app = express();
    app.use(express.json());
    app.use(admin.prefix, admin.router);
    const token = async () =>
        (await request(app).post('/api/v1/qcli/auth/login').send({ username: 'admin', password: 'pass' })).body.token;
    return { app, admin, token };
}

describe('GET /api/v1/qcli/logs/histogram', () => {
    function seed(buffer: LogRingBuffer) {
        const e = (timestamp: string, level: any, message: string, source = 'app') => buffer.push({ timestamp, level, message, source });
        e(at(0, 1), 'INFO', 'started');
        e(at(0, 2), 'INFO', 'request ok');
        e(at(0, 3), 'WARN', 'slow request');
        e(at(1, 0), 'ERROR', 'boom', 'jobs');
        e(at(23, 59), 'DEBUG', 'tick', 'jobs');
        e(UNTIL, 'ERROR', 'outside (to is exclusive)');
        e('2026-11-03T12:00:00.000Z', 'ERROR', 'outside (before from)');
    }

    it('counts entries per level in each column, with totals and the store', async () => {
        const { app, admin, token } = adminApp();
        seed(admin.logBuffer);
        const res = await request(app)
            .get(`/api/v1/qcli/logs/histogram?from=${SINCE}&to=${UNTIL}&buckets=24`)
            .set('Authorization', `Bearer ${await token()}`)
            .expect(200);
        expect(res.body).toMatchObject({ from: SINCE, to: UNTIL, bucketMs: HOUR, store: 'memory' });
        expect(res.body.buckets).toHaveLength(24);
        expect(res.body.buckets[0]).toEqual({ start: SINCE, DEBUG: 0, INFO: 2, WARN: 1, ERROR: 0 });
        expect(res.body.buckets[1]).toEqual({ start: at(1), DEBUG: 0, INFO: 0, WARN: 0, ERROR: 1 });
        expect(res.body.buckets[23].DEBUG).toBe(1);
        expect(res.body.totals).toEqual({ DEBUG: 1, INFO: 2, WARN: 1, ERROR: 1 });
    });

    it('applies the level (comma-separated), search (message or source) and service filters', async () => {
        const { app, admin, token } = adminApp();
        seed(admin.logBuffer);
        const auth = `Bearer ${await token()}`;
        const base = `/api/v1/qcli/logs/histogram?from=${SINCE}&to=${UNTIL}`;
        let res = await request(app).get(`${base}&level=warn,ERROR`).set('Authorization', auth).expect(200);
        expect(res.body.totals).toEqual({ DEBUG: 0, INFO: 0, WARN: 1, ERROR: 1 });
        res = await request(app).get(`${base}&search=REQUEST`).set('Authorization', auth).expect(200);
        expect(res.body.totals).toEqual({ DEBUG: 0, INFO: 1, WARN: 1, ERROR: 0 });
        res = await request(app).get(`${base}&search=jobs`).set('Authorization', auth).expect(200);
        expect(res.body.totals).toEqual({ DEBUG: 1, INFO: 0, WARN: 0, ERROR: 1 });
        res = await request(app).get(`${base}&service=JOBS`).set('Authorization', auth).expect(200);
        expect(res.body.totals).toEqual({ DEBUG: 1, INFO: 0, WARN: 0, ERROR: 1 });
        // The logs endpoint takes the same filters
        res = await request(app).get('/api/v1/qcli/logs?level=WARN,ERROR&service=app').set('Authorization', auth).expect(200);
        expect(res.body.entries.map((e: any) => e.message)).toEqual(['slow request', 'outside (to is exclusive)', 'outside (before from)']);
    });

    it('defaults to the last 24 hours and 24 columns, clamps buckets and answers 400 for bad times', async () => {
        const { app, admin, token } = adminApp();
        const auth = `Bearer ${await token()}`;
        admin.logBuffer.push({ timestamp: new Date(Date.now() - 1000).toISOString(), level: 'INFO', message: 'now', source: 'x' });
        let res = await request(app).get('/api/v1/qcli/logs/histogram').set('Authorization', auth).expect(200);
        expect(res.body.buckets).toHaveLength(24);
        expect(Date.parse(res.body.to) - Date.parse(res.body.from)).toBe(24 * HOUR);
        expect(res.body.totals.INFO).toBeGreaterThanOrEqual(1);
        res = await request(app).get('/api/v1/qcli/logs/histogram?buckets=999').set('Authorization', auth).expect(200);
        expect(res.body.buckets).toHaveLength(200);
        res = await request(app).get('/api/v1/qcli/logs/histogram?buckets=0').set('Authorization', auth).expect(200);
        expect(res.body.buckets).toHaveLength(1);
        res = await request(app).get('/api/v1/qcli/logs/histogram?from=garbage').set('Authorization', auth).expect(400);
        expect(res.body.error).toMatch(/from/);
        await request(app).get(`/api/v1/qcli/logs/histogram?from=${UNTIL}&to=${SINCE}`).set('Authorization', auth).expect(400);
    });

    it('requires the admin auth like GET /logs', async () => {
        const { app } = adminApp();
        await request(app).get('/api/v1/qcli/logs/histogram').expect(401);
    });
});

describe('status history', () => {
    const source = { getActiveWsConnections: () => 2, getActiveShellSessions: () => 1 };

    it('samples at start, then every 15 seconds, with CPU from the second sample', () => {
        vi.useFakeTimers();
        const sampler = new StatusSampler(source);
        sampler.start();
        expect(sampler.history(60)).toHaveLength(1);
        expect(sampler.history(60)[0]).toMatchObject({ cpuPercent: null, activeWsConnections: 2, activeShellSessions: 1 });
        vi.advanceTimersByTime(15_000);
        const samples = sampler.history(60);
        expect(samples).toHaveLength(2);
        expect(typeof samples[1].cpuPercent === 'number' || samples[1].cpuPercent === null).toBe(true);
        expect(samples[1].memoryMb).toBeGreaterThan(0);
        sampler.stop();
        vi.advanceTimersByTime(60_000);
        expect(sampler.history(60)).toHaveLength(2);
    });

    it('does not keep the process alive (unref\'d timer)', () => {
        const unref = vi.fn();
        const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as any);
        const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
        const sampler = new StatusSampler(source);
        sampler.start();
        expect(spy).toHaveBeenCalledWith(expect.any(Function), 15_000);
        expect(unref).toHaveBeenCalled();
        sampler.stop();
        expect(clear).toHaveBeenCalled();
        spy.mockRestore();
        clear.mockRestore();
    });

    it('keeps a ring buffer of the latest samples, oldest first, within the asked minutes', () => {
        const sampler = new StatusSampler(source, 3);
        const t0 = Date.parse(SINCE);
        for (let i = 0; i < 5; i++) {
            sampler.add({ timestamp: new Date(t0 + i * 60_000).toISOString(), memoryMb: i, cpuPercent: null, activeWsConnections: 0, activeShellSessions: 0 });
        }
        const now = t0 + 4 * 60_000;
        expect(sampler.history(60, now).map((s) => s.memoryMb)).toEqual([2, 3, 4]);
        expect(sampler.history(1, now).map((s) => s.memoryMb)).toEqual([3, 4]);
        expect(new StatusSampler(source).capacity).toBe(5760);
    });

    it('GET /status/history answers the samples, clamps minutes, and dispose stops the sampler', async () => {
        const { app, admin, token } = adminApp();
        const auth = `Bearer ${await token()}`;
        let res = await request(app).get('/api/v1/qcli/status/history').set('Authorization', auth).expect(200);
        expect(res.body.intervalSeconds).toBe(15);
        expect(res.body.samples).toHaveLength(1);
        expect(res.body.samples[0]).toEqual({
            timestamp: expect.any(String),
            memoryMb: expect.any(Number),
            cpuPercent: null,
            activeWsConnections: 0,
            activeShellSessions: 0,
        });
        // An old sample: outside the default 60 minutes, inside 1440 (minutes=99999 is clamped)
        admin.statusSampler.add({
            timestamp: new Date(Date.now() - 3 * HOUR).toISOString(),
            memoryMb: 1,
            cpuPercent: 1,
            activeWsConnections: 0,
            activeShellSessions: 0,
        });
        res = await request(app).get('/api/v1/qcli/status/history').set('Authorization', auth).expect(200);
        expect(res.body.samples.some((s: any) => s.memoryMb === 1)).toBe(false);
        res = await request(app).get('/api/v1/qcli/status/history?minutes=99999').set('Authorization', auth).expect(200);
        expect(res.body.samples.some((s: any) => s.memoryMb === 1)).toBe(true);
        res = await request(app).get('/api/v1/qcli/status/history?minutes=0').set('Authorization', auth).expect(200);
        expect(Array.isArray(res.body.samples)).toBe(true);
        await request(app).get('/api/v1/qcli/status/history').expect(401);

        const stop = vi.spyOn(admin.statusSampler, 'stop');
        admin.dispose();
        expect(stop).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 4. Command usage
// ---------------------------------------------------------------------------

function processor(command: string, handle: () => Promise<string>, extra: Partial<ICliCommandProcessor> = {}): ICliCommandProcessor {
    return { command, description: command, author: DefaultLibraryAuthor, version: '1.0.0', handleAsync: handle, ...extra };
}

function usageApp() {
    const registry = new CliCommandRegistry();
    registry.register(processor('echo', async () => 'hi'));
    registry.register(processor('boom', async () => { throw new Error('nope'); }));
    registry.register(processor('stats', async () => 'a command named stats'));
    registry.register(
        processor('exit2', async () => '', {
            handleStructuredAsync: async () => ({ exitCode: 2, outputs: [] }),
        }),
    );
    const executor = new CliCommandExecutorService(registry);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/qcli', createCliController(registry, executor));
    return { app, executor };
}

describe('command usage counters', () => {
    it('keys by the first word, lower-case', () => {
        expect(CliCommandUsageStats.keyOf('Echo hello')).toBe('echo');
        expect(CliCommandUsageStats.keyOf('  ECHO')).toBe('echo');
        expect(CliCommandUsageStats.keyOf(undefined)).toBe('');
    });

    it('counts /execute and /execute/stream runs, failures, unknown commands, sorted by executions', async () => {
        const { app } = usageApp();
        const before = Date.now();
        await request(app).post('/api/v1/qcli/execute').send({ command: 'echo', value: 'a' }).expect(200);
        await request(app).post('/api/v1/qcli/execute').send({ command: 'ECHO' }).expect(200);
        await request(app).post('/api/v1/qcli/execute/stream').send({ command: 'echo' }).expect(200);
        await request(app).post('/api/v1/qcli/execute').send({ command: 'boom' }).expect(200);
        await request(app).post('/api/v1/qcli/execute/stream').send({ command: 'boom' }).expect(200);
        await request(app).post('/api/v1/qcli/execute').send({ command: 'exit2' }).expect(200);
        await request(app).post('/api/v1/qcli/execute').send({ command: 'nosuch' }).expect(200);
        await request(app).post('/api/v1/qcli/execute/stream').send({ command: 'nosuch' }).expect(200);

        const res = await request(app).get('/api/v1/qcli/commands/stats').expect(200);
        expect(Date.parse(res.body.since)).toBeLessThanOrEqual(before);
        expect(res.body.commands.map((c: any) => c.command)).toEqual(['echo', 'boom', 'nosuch', 'exit2']);
        const by = Object.fromEntries(res.body.commands.map((c: any) => [c.command, c]));
        expect(by.echo).toMatchObject({ known: true, executions: 3, failures: 0, lastFailedAt: null });
        expect(typeof by.echo.avgDuration).toBe('number');
        expect(Date.parse(by.echo.lastExecutedAt)).toBeGreaterThanOrEqual(before);
        expect(by.boom).toMatchObject({ known: true, executions: 2, failures: 2 });
        expect(by.boom.lastFailedAt).not.toBeNull();
        expect(by.exit2).toMatchObject({ known: true, executions: 1, failures: 1 });
        expect(by.nosuch).toMatchObject({ known: false, executions: 2, failures: 2 });
    });

    it('is not taken by a command named "stats"', async () => {
        const { app } = usageApp();
        await request(app).post('/api/v1/qcli/execute').send({ command: 'stats' }).expect(200);
        const res = await request(app).get('/api/v1/qcli/commands/stats').expect(200);
        expect(res.body).toHaveProperty('since');
        expect(res.body.commands).toEqual([expect.objectContaining({ command: 'stats', known: true, executions: 1 })]);
        // GET /commands still lists the processors
        const list = await request(app).get('/api/v1/qcli/commands').expect(200);
        expect(Array.isArray(list.body)).toBe(true);
    });

    it('counts MCP tool calls (same executor) and follows the auth of GET /commands on a full server', async () => {
        const cli: CliServerResult = createCliServer({
            mcp: true,
            configure: (b) => b.addProcessor(processor('echo', async () => 'hi')),
        });
        disposables.push(() => {
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        await cli.executor.executeAsync({ command: 'echo' } as any);
        const res = await request(cli.app).get('/api/v1/qcli/commands/stats').expect(200);
        expect(res.body.commands[0]).toMatchObject({ command: 'echo', executions: 1 });
    });
});

describe('auth on a protected server', () => {
    it('commands/stats and jobs/stats follow their neighbours (authenticated, jobs:read)', async () => {
        const cli = createCliServer();
        const users = new CliUsersBuilder()
            .setDefaultAdminPassword('admin123')
            .setMinPasswordLength(4)
            .setIpRateLimit(10_000)
            .build((msg) => cli.eventSocketManager.broadcastMessage(msg));
        disposables.push(() => {
            users.dispose();
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        await users.ready;
        cli.mountPlugin(users);
        const jobs = new CliJobsBuilder().addJob(new NoopJob(), { name: 'one', interval: '999s' }).build();
        cli.app.use(jobs.prefix, jobs.router);
        const app = cli.app as express.Express;

        await request(app).get('/api/v1/qcli/commands').expect(401);
        await request(app).get('/api/v1/qcli/commands/stats').expect(401);
        await request(app).get('/api/v1/qcli/jobs/stats').expect(401);
        const root = await login(app, 'root', 'admin123');
        await request(app).get('/api/v1/qcli/commands/stats').set(auth(root.token)).expect(200);
        await request(app).get('/api/v1/qcli/jobs/stats').set(auth(root.token)).expect(200);
    });
});

// ---------------------------------------------------------------------------
// 5. Audit time filter
// ---------------------------------------------------------------------------

describe('GET /api/v1/qcli/audit from/to', () => {
    async function auditApp() {
        const store = new InMemoryAuditStore();
        const plugin = new CliAuditBuilder().setStore(store).build();
        const app = express();
        app.use(express.json());
        app.use(plugin.prefix, plugin.router);
        const t = (iso: string) => Date.parse(iso);
        await store.log({ timestamp: t('2026-11-04T10:00:00Z'), event: 'login', username: 'a' });
        await store.log({ timestamp: t('2026-11-04T12:00:00Z'), event: 'login', username: 'b' });
        await store.log({ timestamp: t('2026-11-04T14:00:00Z'), event: 'logout', username: 'b' });
        await store.log({ timestamp: t('2026-11-05T00:00:00Z'), event: 'login', username: 'c' });
        return { app, store };
    }

    it('keeps from <= timestamp < to, with ISO 8601 or epoch milliseconds', async () => {
        const { app } = await auditApp();
        let res = await request(app).get('/api/v1/qcli/audit?from=2026-11-04T12:00:00Z&to=2026-11-05T00:00:00Z').expect(200);
        expect(res.body.map((e: any) => e.username)).toEqual(['b', 'b']);
        res = await request(app).get(`/api/v1/qcli/audit?from=${Date.parse('2026-11-04T11:00:00Z')}`).expect(200);
        expect(res.body.map((e: any) => e.username)).toEqual(['c', 'b', 'b']);
        res = await request(app).get('/api/v1/qcli/audit?to=2026-11-04T12:00:00').expect(200); // no offset = UTC
        expect(res.body.map((e: any) => e.username)).toEqual(['a']);
    });

    it('combines with the other filters and paging', async () => {
        const { app } = await auditApp();
        let res = await request(app).get('/api/v1/qcli/audit?event=login&from=2026-11-04T11:00:00Z').expect(200);
        expect(res.body.map((e: any) => e.username)).toEqual(['c', 'b']);
        res = await request(app).get('/api/v1/qcli/audit?from=2026-11-04T00:00:00Z&to=2026-11-05T00:00:00Z&limit=1&offset=1').expect(200);
        expect(res.body.map((e: any) => e.event)).toEqual(['login']);
        expect(res.body[0].username).toBe('b');
    });

    it('answers 400 for a bad time', async () => {
        const { app } = await auditApp();
        const res = await request(app).get('/api/v1/qcli/audit?from=last-week').expect(400);
        expect(res.body.error).toMatch(/from/);
        await request(app).get('/api/v1/qcli/audit?to=2026-02-31Tx').expect(400);
    });

    it('passes From/To to the store query', async () => {
        const { app, store } = await auditApp();
        const spy = vi.spyOn(store, 'getEntries');
        await request(app).get('/api/v1/qcli/audit?from=2026-11-04T00:00:00Z&to=1762300800000').expect(200);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
            from: new Date('2026-11-04T00:00:00Z'),
            to: new Date(1762300800000),
        }));
    });
});
