import { ICliJob, CliJobOptions, ICliJobStorageProvider } from '@qodalis/cli-server-abstractions';
import { Router } from 'express';
import { CliJobScheduler } from './cli-job-scheduler';
import { InMemoryJobStorageProvider } from './in-memory-job-storage-provider';
import { createCliJobsController } from './cli-jobs-controller';

export interface CliJobsPluginResult {
    /** Default mount prefix for this plugin. */
    prefix: '/api/v1/qcli/jobs';
    /** Express router for the jobs API. */
    router: Router;
    /** The job scheduler instance. Call `start()` / `stop()` to manage its lifecycle. */
    scheduler: CliJobScheduler;
}

/**
 * Fluent builder for configuring the jobs plugin independently of the core CLI server.
 *
 * @example
 * ```ts
 * import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
 *
 * const jobsPlugin = new CliJobsBuilder()
 *     .addJob(new SampleHealthCheckJob(), { name: 'health-check', interval: '30s' })
 *     .build((msg) => eventSocketManager.broadcastMessage(msg));
 *
 * app.use('/api/v1/qcli/jobs', jobsPlugin.router);
 * await jobsPlugin.scheduler.start();
 * ```
 */
export class CliJobsBuilder {
    private readonly _jobs: Array<{ job: ICliJob; options: CliJobOptions }> = [];
    private _storageProvider?: ICliJobStorageProvider;

    /**
     * Register a job to be managed by the scheduler.
     */
    addJob(job: ICliJob, options: CliJobOptions): CliJobsBuilder {
        this._jobs.push({ job, options });
        return this;
    }

    /**
     * Set a custom storage provider for job state and execution history.
     * If not set, an in-memory provider will be used.
     */
    setStorageProvider(provider: ICliJobStorageProvider): CliJobsBuilder {
        this._storageProvider = provider;
        return this;
    }

    /**
     * Build the plugin, returning the Express router and scheduler.
     *
     * @param broadcastFn Optional function to broadcast job events (e.g. via WebSocket).
     */
    build(broadcastFn?: (message: Record<string, unknown>) => void): CliJobsPluginResult {
        const storage = this._storageProvider ?? new InMemoryJobStorageProvider();
        const scheduler = new CliJobScheduler(storage);

        for (const { job, options } of this._jobs) {
            scheduler.register(job, options);
        }

        if (broadcastFn) {
            scheduler.setBroadcastFn(broadcastFn);
        }

        const router = createCliJobsController(scheduler, storage);

        return { prefix: '/api/v1/qcli/jobs', router, scheduler };
    }
}
