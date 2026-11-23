/**
 * Job history on large stores (cli-server-dotnet#96): lists may leave the logs out (with
 * `logCount`), one run keeps them, and `summarizeExecutions` counts runs per job and status.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    ICliJob,
    ICliJobExecutionContext,
    ICliJobStorageProvider,
    JobExecution,
    JobExecutionQuery,
    JobExecutionStatus,
    JobExecutionSummary,
    summarizeJobExecutions,
} from '@qodalis/cli-server-abstractions';
import { InMemoryJobStorageProvider } from '../../plugins/jobs/in-memory-job-storage-provider';
import { CliJobScheduler, INTERRUPTED_RUN_ERROR } from '../../plugins/jobs/cli-job-scheduler';
import { createCliJobsController } from '../../plugins/jobs/cli-jobs-controller';

class IdleJob implements ICliJob {
    async executeAsync(_context: ICliJobExecutionContext, _signal: AbortSignal): Promise<void> {}
}

const withoutLogs = (e: JobExecution): JobExecution => ({ ...e, logs: [], logCount: e.logs.length });

/** A store that lists runs without their logs, as a database store does. */
class LogLessListStore extends InMemoryJobStorageProvider {
    override async getExecutions(jobId: string, options?: { limit?: number; offset?: number; status?: JobExecutionStatus }) {
        const page = await super.getExecutions(jobId, options);
        return { ...page, items: page.items.map(withoutLogs) };
    }

    override async queryExecutions(query: JobExecutionQuery) {
        const page = await super.queryExecutions(query);
        return query.includeLogs ? page : { ...page, items: page.items.map(withoutLogs) };
    }
}

const run = (id: string, jobId: string, status: JobExecutionStatus, startedAt: Date, logs = 1): JobExecution => ({
    id,
    jobId,
    jobName: jobId,
    status,
    startedAt: startedAt.toISOString(),
    logs: Array.from({ length: logs }, (_, i) => ({
        timestamp: new Date(startedAt.getTime() + (i + 1) * 1000).toISOString(),
        level: 'info' as const,
        message: `line ${i + 1}`,
    })),
    retryAttempt: 0,
});

const hoursAgo = (now: Date, hours: number) => new Date(now.getTime() - hours * 3_600_000);

async function seed(storage: ICliJobStorageProvider, now: Date): Promise<void> {
    const cases: [string, JobExecutionStatus, number][] = [
        ['a', 'completed', 1], ['a', 'completed', 3], ['a', 'failed', 2],
        ['b', 'failed', 5], ['a', 'completed', 30], ['c', 'completed', 48],
    ];
    let n = 0;
    for (const [job, status, hours] of cases) await storage.saveExecution(run(`r${n++}`, job, status, hoursAgo(now, hours)));
}

function expectSummary(summary: JobExecutionSummary[], now: Date): void {
    expect(summary.map((s) => `${s.jobId}:${s.status}:${s.count}`)).toEqual(['a:completed:2', 'a:failed:1', 'b:failed:1']);
    expect(summary[0].lastStartedAt).toBe(hoursAgo(now, 1).toISOString());
    expect(summary[2].lastStartedAt).toBe(hoursAgo(now, 5).toISOString());
}

describe('job run summary', () => {
    it('groups the in-memory runs by job and status since a time', async () => {
        const storage = new InMemoryJobStorageProvider();
        const now = new Date();
        await seed(storage, now);

        expectSummary(await storage.summarizeExecutions(hoursAgo(now, 24)), now);
        expectSummary(await summarizeJobExecutions(storage, hoursAgo(now, 24)), now);
        expect((await storage.summarizeExecutions(hoursAgo(now, 24), ['b'])).map((s) => s.jobId)).toEqual(['b']);
        expect(await storage.summarizeExecutions(new Date(now.getTime() + 60_000))).toEqual([]);
    });

    it('defaults to the per-job listings of a store without a summary or query of its own', async () => {
        const inner = new InMemoryJobStorageProvider();
        const store: ICliJobStorageProvider = {
            saveExecution: (e) => inner.saveExecution(e),
            getExecutions: (jobId, options) => inner.getExecutions(jobId, options),
            getExecution: (id) => inner.getExecution(id),
            saveJobState: (jobId, state) => inner.saveJobState(jobId, state),
            getJobState: (jobId) => inner.getJobState(jobId),
            getAllJobStates: () => inner.getAllJobStates(),
        };
        const now = new Date();
        await seed(store, now);

        expectSummary(await summarizeJobExecutions(store, hoursAgo(now, 24), ['a', 'b', 'c']), now);
        await expect(summarizeJobExecutions(store, hoursAgo(now, 24))).rejects.toThrow(/not supported/);
    });
});

describe('logs in job lists', () => {
    it('the in-memory store keeps them', async () => {
        const storage = new InMemoryJobStorageProvider();
        await storage.saveExecution(run('r1', 'a', 'completed', new Date(), 2));

        const { items } = await storage.getExecutions('a');
        expect(items[0].logs).toHaveLength(2);
        expect(items[0].logCount).toBeUndefined();
    });

    it('the API lists the store\'s log count and reads the logs from the single run', async () => {
        const storage = new LogLessListStore();
        const scheduler = new CliJobScheduler(storage);
        scheduler.register(new IdleJob(), { id: 'j', interval: '999s' });
        await storage.saveExecution(run('r1', 'j', 'completed', new Date(), 2));
        const app = express();
        app.use('/jobs', createCliJobsController(scheduler, storage));

        const history = await request(app).get('/jobs/j/history');
        expect(history.body.items[0]).toMatchObject({ id: 'r1', logCount: 2 });
        expect(history.body.items[0].logs).toBeUndefined();

        const across = await request(app).get('/jobs/executions?job=j');
        expect(across.body.items[0]).toMatchObject({ id: 'r1', logCount: 2 });

        const detail = await request(app).get('/jobs/j/history/r1');
        expect(detail.body.logs.map((l: { message: string }) => l.message)).toEqual(['line 1', 'line 2']);
        await scheduler.stop();
    });

    it('the scheduler asks for the logs of interrupted runs, to finish them at their last entry', async () => {
        const storage = new LogLessListStore();
        await storage.saveExecution(run('left', 'j', 'running', new Date('2026-11-06T09:00:00.000Z'), 3));

        const scheduler = new CliJobScheduler(storage);
        scheduler.register(new IdleJob(), { id: 'j', interval: '999s' });
        await scheduler.start();

        expect(await storage.getExecution('left')).toMatchObject({
            status: 'cancelled',
            error: INTERRUPTED_RUN_ERROR,
            completedAt: '2026-11-06T09:00:03.000Z',
            duration: 3000,
        });
        expect((await storage.getExecution('left'))!.logs).toHaveLength(3);
        await scheduler.stop();
    });
});
