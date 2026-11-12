import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    ICliJob,
    ICliJobExecutionContext,
    CliJobOptions,
    JobExecution,
    JobExecutionStatus,
} from '@qodalis/cli-server-abstractions';
import { InMemoryJobStorageProvider } from '../../plugins/jobs/in-memory-job-storage-provider';
import { CliJobsBuilder, CliJobsPluginResult } from '../../plugins/jobs/cli-jobs-builder';
import { createCliJobsController } from '../../plugins/jobs/cli-jobs-controller';

// ---------------------------------------------------------------------------
// Test jobs
// ---------------------------------------------------------------------------

class QuickJob implements ICliJob {
    private calls = 0;
    async executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void> {
        context.properties.calls = ++this.calls;
        context.logger.info('quick job ran');
    }
}

class SlowJob implements ICliJob {
    async executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void> {
        for (let i = 0; i < 100; i++) {
            if (signal.aborted) return;
            await new Promise((r) => setTimeout(r, 20));
        }
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let plugin: CliJobsPluginResult;
let app: express.Express;
let jobIds: Record<string, string>;

function setup() {
    plugin = new CliJobsBuilder()
        .addJob(new QuickJob(), { name: 'quick', interval: '999s' })
        .addJob(new SlowJob(), { name: 'slow', group: 'Reports', interval: '999s' })
        .build();

    app = express();
    app.use(express.json());
    app.use(plugin.prefix, plugin.router);

    jobIds = {};
    const all = plugin.scheduler.getAll();
    for (const job of all) {
        jobIds[job.name] = job.id;
    }
}

beforeEach(() => {
    setup();
});

afterEach(async () => {
    await plugin.scheduler.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/qcli/jobs', () => {
    it('returns all jobs', async () => {
        const res = await request(app).get('/api/v1/qcli/jobs');
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        const names = new Set(res.body.map((j: any) => j.name));
        expect(names).toEqual(new Set(['quick', 'slow']));
    });

    it('job dto has expected shape', async () => {
        const res = await request(app).get('/api/v1/qcli/jobs');
        const job = res.body[0];
        expect(job).toHaveProperty('id');
        expect(job).toHaveProperty('name');
        expect(job).toHaveProperty('status');
        expect(job).toHaveProperty('maxRetries');
        expect(job).toHaveProperty('overlapPolicy');
    });
});

describe('GET /api/v1/qcli/jobs/:id', () => {
    it('returns job by id', async () => {
        const res = await request(app).get(`/api/v1/qcli/jobs/${jobIds['quick']}`);
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('quick');
    });

    it('returns 404 for nonexistent job', async () => {
        const res = await request(app).get('/api/v1/qcli/jobs/nonexistent');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('JOB_NOT_FOUND');
    });
});

describe('POST /api/v1/qcli/jobs/:id/trigger', () => {
    it('triggers job', async () => {
        (plugin.scheduler as any)._running = true;
        const res = await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/trigger`);
        expect(res.status).toBe(200);
        await new Promise((r) => setTimeout(r, 200));
    });

    it('returns 404 for nonexistent job', async () => {
        const res = await request(app).post('/api/v1/qcli/jobs/nonexistent/trigger');
        expect(res.status).toBe(404);
    });
});

describe('POST /api/v1/qcli/jobs/:id/pause & resume', () => {
    it('pauses a job', async () => {
        (plugin.scheduler as any)._running = true;
        const res = await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/pause`);
        expect(res.status).toBe(200);
    });

    it('pause already paused returns 409', async () => {
        (plugin.scheduler as any)._running = true;
        await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/pause`);
        const res = await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/pause`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('JOB_ALREADY_PAUSED');
    });

    it('resumes a paused job', async () => {
        (plugin.scheduler as any)._running = true;
        await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/pause`);
        const res = await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/resume`);
        expect(res.status).toBe(200);
    });

    it('resume not paused returns 409', async () => {
        (plugin.scheduler as any)._running = true;
        const res = await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/resume`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('JOB_NOT_PAUSED');
    });
});

describe('POST /api/v1/qcli/jobs/:id/stop', () => {
    it('stops a job', async () => {
        (plugin.scheduler as any)._running = true;
        const res = await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/stop`);
        expect(res.status).toBe(200);
    });

    it('returns 404 for nonexistent job', async () => {
        const res = await request(app).post('/api/v1/qcli/jobs/nonexistent/stop');
        expect(res.status).toBe(404);
    });
});

describe('POST /api/v1/qcli/jobs/:id/cancel', () => {
    it('cancel when not running returns 409', async () => {
        (plugin.scheduler as any)._running = true;
        const res = await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/cancel`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('JOB_NOT_RUNNING');
    });
});

describe('PUT /api/v1/qcli/jobs/:id', () => {
    it('updates job description and maxRetries', async () => {
        (plugin.scheduler as any)._running = true;
        const res = await request(app)
            .put(`/api/v1/qcli/jobs/${jobIds['quick']}`)
            .send({ description: 'updated', maxRetries: 5 });
        expect(res.status).toBe(200);
        const reg = plugin.scheduler.getRegistration(jobIds['quick'])!;
        expect(reg.options.description).toBe('updated');
        expect(reg.options.maxRetries).toBe(5);
    });

    it('returns 400 for invalid schedule', async () => {
        (plugin.scheduler as any)._running = true;
        const res = await request(app)
            .put(`/api/v1/qcli/jobs/${jobIds['quick']}`)
            .send({ schedule: 'not-valid' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_SCHEDULE');
    });

    it('returns 404 for nonexistent job', async () => {
        const res = await request(app).put('/api/v1/qcli/jobs/nonexistent').send({ description: 'x' });
        expect(res.status).toBe(404);
    });
});

describe('GET /api/v1/qcli/jobs/:id/history', () => {
    it('returns empty history', async () => {
        const res = await request(app).get(`/api/v1/qcli/jobs/${jobIds['quick']}/history`);
        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([]);
        expect(res.body.total).toBe(0);
    });

    it('returns history after trigger', async () => {
        (plugin.scheduler as any)._running = true;
        await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/trigger`);
        await new Promise((r) => setTimeout(r, 200));
        const res = await request(app).get(`/api/v1/qcli/jobs/${jobIds['quick']}/history`);
        expect(res.status).toBe(200);
        expect(res.body.total).toBeGreaterThanOrEqual(1);
        expect(res.body.items[0].status).toBe('completed');
    });

    it('returns 404 for nonexistent job', async () => {
        const res = await request(app).get('/api/v1/qcli/jobs/nonexistent/history');
        expect(res.status).toBe(404);
    });

    it('returns execution detail with logs', async () => {
        (plugin.scheduler as any)._running = true;
        await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/trigger`);
        await new Promise((r) => setTimeout(r, 200));
        const history = await request(app).get(`/api/v1/qcli/jobs/${jobIds['quick']}/history`);
        const execId = history.body.items[0].id;
        const res = await request(app).get(`/api/v1/qcli/jobs/${jobIds['quick']}/history/${execId}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('logs');
        expect(res.body.logs.length).toBeGreaterThan(0);
    });

    it('returns 404 for nonexistent execution', async () => {
        const res = await request(app).get(
            `/api/v1/qcli/jobs/${jobIds['quick']}/history/nonexistent`,
        );
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('EXECUTION_NOT_FOUND');
    });
});

describe('GET /api/v1/qcli/jobs/executions', () => {
    const executions = (query = '') => request(app).get(`/api/v1/qcli/jobs/executions${query}`);

    it('lists executions across jobs, filtered by job, group, status and since', async () => {
        (plugin.scheduler as any)._running = true;
        await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/trigger`);
        await new Promise((r) => setTimeout(r, 5));
        await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/trigger`);

        const all = await executions();
        expect(all.status).toBe(200);
        expect(all.body).toMatchObject({ total: 2, limit: 20, offset: 0 });
        expect(all.body.items[0]).toMatchObject({
            jobId: 'quick',
            jobName: 'quick',
            status: 'completed',
            logCount: 1,
            properties: { calls: 2 },
        });
        expect(all.body.items[0]).not.toHaveProperty('logs');

        expect((await executions(`?job=${jobIds['quick']},${jobIds['slow']}`)).body.total).toBe(2);
        expect((await executions(`?job=${jobIds['slow']}&job=${jobIds['quick']}`)).body.total).toBe(2);
        expect((await executions(`?job=${jobIds['slow']}`)).body.total).toBe(0);
        expect((await executions('?status=failed')).body.total).toBe(0);
        expect((await executions('?status=completed')).body.total).toBe(2);
        expect((await executions('?limit=1&offset=1')).body).toMatchObject({ limit: 1, offset: 1, items: [{ properties: { calls: 1 } }] });
        expect((await executions(`?since=${new Date(Date.now() + 60_000).toISOString()}`)).body.total).toBe(0);
        expect((await executions(`?since=${new Date(Date.now() - 60_000).toISOString()}`)).body.total).toBe(2);
        // The group (case-insensitive), intersected with the job filter
        expect((await executions('?group=reports')).body.total).toBe(0);
        expect((await executions(`?group=reports&job=${jobIds['quick']}`)).body.total).toBe(0);
        // No job in the group: nothing, not every job
        expect((await executions('?group=none')).body.total).toBe(0);
    });

    it('clamps limit and offset and rejects a bad since', async () => {
        expect((await executions('?limit=1000&offset=-5')).body).toMatchObject({ limit: 100, offset: 0 });
        expect((await executions('?limit=0')).body.limit).toBe(1);
        const bad = await executions('?since=yesterday');
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('INVALID_QUERY');
    });

    it('history and execution detail carry the properties', async () => {
        (plugin.scheduler as any)._running = true;
        await request(app).post(`/api/v1/qcli/jobs/${jobIds['quick']}/trigger`);
        const history = await request(app).get(`/api/v1/qcli/jobs/${jobIds['quick']}/history`);
        expect(history.body.items[0].properties).toEqual({ calls: 1 });
        const detail = await request(app).get(`/api/v1/qcli/jobs/${jobIds['quick']}/history/${history.body.items[0].id}`);
        expect(detail.body.properties).toEqual({ calls: 1 });
    });
});

describe('DELETE /api/v1/qcli/jobs/:id/history', () => {
    let storage: InMemoryJobStorageProvider;
    let deleteApp: express.Express;
    let deletePlugin: CliJobsPluginResult;

    const run = (id: string, jobId: string, status: JobExecutionStatus): JobExecution => ({
        id,
        jobId,
        jobName: jobId,
        status,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        logs: [{ timestamp: new Date().toISOString(), level: 'info', message: 'ran' }],
        retryAttempt: 0,
    });

    beforeEach(async () => {
        storage = new InMemoryJobStorageProvider();
        deletePlugin = new CliJobsBuilder()
            .addJob(new QuickJob(), { id: 'a', name: 'a', interval: '999s' })
            .addJob(new QuickJob(), { id: 'b', name: 'b', interval: '999s' })
            .setStorageProvider(storage)
            .build();
        deleteApp = express();
        deleteApp.use(express.json());
        deleteApp.use(deletePlugin.prefix, deletePlugin.router);
        await storage.saveExecution(run('a1', 'a', 'completed'));
        await storage.saveExecution(run('a2', 'a', 'failed'));
        await storage.saveExecution(run('a3', 'a', 'failed'));
        await storage.saveExecution(run('a4', 'a', 'running'));
        await storage.saveExecution(run('b1', 'b', 'completed'));
    });

    it('deletes one run and its logs', async () => {
        const res = await request(deleteApp).delete('/api/v1/qcli/jobs/a/history/a1');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: 'Run deleted' });
        expect(await storage.getExecution('a1')).toBeNull();
        const detail = await request(deleteApp).get('/api/v1/qcli/jobs/a/history/a1');
        expect(detail.status).toBe(404);
    });

    it('404 JOB_NOT_FOUND for an unknown job', async () => {
        const one = await request(deleteApp).delete('/api/v1/qcli/jobs/missing/history/a1');
        expect(one.status).toBe(404);
        expect(one.body.code).toBe('JOB_NOT_FOUND');
        const many = await request(deleteApp).delete('/api/v1/qcli/jobs/missing/history');
        expect(many.status).toBe(404);
        expect(many.body.code).toBe('JOB_NOT_FOUND');
    });

    it('404 EXECUTION_NOT_FOUND for a missing run or another job\'s run', async () => {
        const missing = await request(deleteApp).delete('/api/v1/qcli/jobs/a/history/nope');
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('EXECUTION_NOT_FOUND');
        const other = await request(deleteApp).delete('/api/v1/qcli/jobs/a/history/b1');
        expect(other.status).toBe(404);
        expect(other.body.code).toBe('EXECUTION_NOT_FOUND');
        expect(await storage.getExecution('b1')).not.toBeNull();
    });

    it('409 EXECUTION_RUNNING for a running run', async () => {
        const res = await request(deleteApp).delete('/api/v1/qcli/jobs/a/history/a4');
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('EXECUTION_RUNNING');
        expect(await storage.getExecution('a4')).not.toBeNull();
    });

    it('deletes every finished run of the job, never running ones', async () => {
        const res = await request(deleteApp).delete('/api/v1/qcli/jobs/a/history');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ deleted: 3 });
        const left = await storage.getExecutions('a', { limit: 100 });
        expect(left.items.map((e) => e.id)).toEqual(['a4']);
        expect(await storage.getExecution('b1')).not.toBeNull();
    });

    it('deletes only the runs with the status', async () => {
        const res = await request(deleteApp).delete('/api/v1/qcli/jobs/a/history?status=failed');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ deleted: 2 });
        const left = await storage.getExecutions('a', { limit: 100 });
        expect(left.items.map((e) => e.id).sort()).toEqual(['a1', 'a4']);
    });

    it('deletes more runs than one page', async () => {
        for (let i = 0; i < 250; i++) await storage.saveExecution(run(`bulk-${i}`, 'b', 'completed'));
        const res = await request(deleteApp).delete('/api/v1/qcli/jobs/b/history');
        expect(res.body).toEqual({ deleted: 251 });
        expect((await storage.getExecutions('b')).total).toBe(0);
    });

    it('501 NOT_SUPPORTED when the storage cannot delete runs', async () => {
        const keepAll = new InMemoryJobStorageProvider();
        (keepAll as any).deleteExecution = undefined;
        await keepAll.saveExecution(run('k1', 'k', 'completed'));
        const p = new CliJobsBuilder()
            .addJob(new QuickJob(), { id: 'k', name: 'k', interval: '999s' })
            .setStorageProvider(keepAll)
            .build();
        const a = express();
        a.use(p.prefix, p.router);
        const one = await request(a).delete('/api/v1/qcli/jobs/k/history/k1');
        expect(one.status).toBe(501);
        expect(one.body.code).toBe('NOT_SUPPORTED');
        const many = await request(a).delete('/api/v1/qcli/jobs/k/history');
        expect(many.status).toBe(501);
        expect(many.body.code).toBe('NOT_SUPPORTED');
        expect(await keepAll.getExecution('k1')).not.toBeNull();
    });
});

describe('Job tags', () => {
    let tagged: CliJobsPluginResult;
    let tagApp: express.Express;

    beforeEach(() => {
        tagged = new CliJobsBuilder()
            .addJob(new QuickJob(), { id: 'ro-bnr', name: 'bnr', interval: '999s', tags: ['country:ro', 'Official', ' official '] })
            .addJob(new QuickJob(), { id: 'ro-bt', name: 'bt', interval: '999s', tags: ['country:ro', 'bank'] })
            .addJob(new QuickJob(), { id: 'md-maib', name: 'maib', group: 'banks', interval: '999s', tags: ['country:md', 'bank'] })
            .addJob(new QuickJob(), { id: 'cleanup', name: 'cleanup', interval: '999s' })
            .build();
        tagApp = express();
        tagApp.use(express.json());
        tagApp.use(tagged.prefix, tagged.router);
    });

    afterEach(async () => {
        await tagged.scheduler.stop();
    });

    it('returns tags in job info, trimmed and without duplicates (ignoring case)', async () => {
        const res = await request(tagApp).get('/api/v1/qcli/jobs/ro-bnr');
        expect(res.body.tags).toEqual(['country:ro', 'Official']);
        const none = await request(tagApp).get('/api/v1/qcli/jobs/cleanup');
        expect(none.body.tags).toEqual([]);
    });

    it('lists the jobs that have every tag given, ignoring case', async () => {
        const ids = async (query: string) => (await request(tagApp).get(`/api/v1/qcli/jobs${query}`)).body.map((j: any) => j.id).sort();
        expect(await ids('')).toEqual(['cleanup', 'md-maib', 'ro-bnr', 'ro-bt']);
        expect(await ids('?tag=COUNTRY:RO')).toEqual(['ro-bnr', 'ro-bt']);
        expect(await ids('?tag=country:ro&tag=bank')).toEqual(['ro-bt']);
        expect(await ids('?tag=country:ro,bank')).toEqual(['ro-bt']);
        expect(await ids('?tag=missing')).toEqual([]);
    });

    it('filters executions by tag, with group', async () => {
        await tagged.scheduler.triggerAsync('ro-bt');
        await tagged.scheduler.triggerAsync('md-maib');
        await new Promise((r) => setTimeout(r, 50));
        const byTag = await request(tagApp).get('/api/v1/qcli/jobs/executions?tag=bank');
        expect(byTag.body.items.map((e: any) => e.jobId).sort()).toEqual(['md-maib', 'ro-bt']);
        const withGroup = await request(tagApp).get('/api/v1/qcli/jobs/executions?tag=bank&group=banks');
        expect(withGroup.body.items.map((e: any) => e.jobId)).toEqual(['md-maib']);
        const none = await request(tagApp).get('/api/v1/qcli/jobs/executions?tag=missing');
        expect(none.body).toMatchObject({ items: [], total: 0 });
    });

    it('PUT replaces the tags, null clears them, invalid tags are 400 INVALID_VALUE', async () => {
        const put = (body: unknown) => request(tagApp).put('/api/v1/qcli/jobs/cleanup').send(body);
        expect((await put({ tags: ['maintenance', 'Maintenance', 'nightly'] })).body.tags).toEqual(['maintenance', 'nightly']);
        expect((await request(tagApp).get('/api/v1/qcli/jobs?tag=nightly')).body.map((j: any) => j.id)).toEqual(['cleanup']);
        expect((await put({ tags: null })).body.tags).toEqual([]);
        for (const tags of ['nightly', ['a,b'], [''], [1], ['x'.repeat(65)], Array.from({ length: 21 }, (_, i) => `t${i}`)]) {
            const res = await put({ tags });
            expect(res.status, JSON.stringify(tags)).toBe(400);
            expect(res.body.code).toBe('INVALID_VALUE');
        }
        // Leaving tags out keeps them
        await put({ tags: ['kept'] });
        expect((await put({ description: 'd' })).body.tags).toEqual(['kept']);
    });

    it('refuses invalid tags at registration', () => {
        expect(() => new CliJobsBuilder().addJob(new QuickJob(), { name: 'x', tags: ['a,b'] }).build()).toThrow(/Invalid tag/);
    });
});
