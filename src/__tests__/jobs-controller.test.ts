import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    ICliJob,
    ICliJobExecutionContext,
    CliJobOptions,
} from '@qodalis/cli-server-abstractions';
import { CliJobsBuilder, CliJobsPluginResult } from '../../plugins/jobs/cli-jobs-builder';
import { createCliJobsController } from '../../plugins/jobs/cli-jobs-controller';

// ---------------------------------------------------------------------------
// Test jobs
// ---------------------------------------------------------------------------

class QuickJob implements ICliJob {
    async executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void> {
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
        .addJob(new SlowJob(), { name: 'slow', interval: '999s' })
        .build();

    app = express();
    app.use(express.json());
    app.use('/api/v1/qcli/jobs', plugin.router);

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
