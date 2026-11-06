import {
    ICliJob,
    CliJobOptions,
    ICliJobStorageProvider,
    CliInstalledPlugin,
    CliEventBroadcastFn,
    ICliEventBus,
    resolveCliEventBus,
} from '@qodalis/cli-server-abstractions';
import { Router } from 'express';
import { CliJobScheduler } from './cli-job-scheduler';
import { InMemoryJobStorageProvider } from './in-memory-job-storage-provider';
import { createCliJobsController } from './cli-jobs-controller';
import { jobsInstalledPlugin } from './package-info';

export interface CliJobsPluginResult {
    /** Default mount prefix for this plugin. */
    prefix: '/api/v1/qcli/jobs';
    /** Express router for the jobs API. */
    router: Router;
    /** The job scheduler instance. Call `start()` / `stop()` to manage its lifecycle. */
    scheduler: CliJobScheduler;
    /** This package, listed among the server's installed plugins by `mountPlugin`. */
    installedPlugin: CliInstalledPlugin;
    /**
     * Publishes the job events on `eventBus` unless `build()` was given a bus or a
     * broadcast function. `mountPlugin` calls it with the server's bus.
     */
    setEventBus(eventBus: ICliEventBus): void;
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
 *     .build(eventBus); // or build() and mountPlugin(jobsPlugin), which hands it the server's bus
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
     * @param events The server's event bus (`createCliServer().eventBus`), or a function
     *   broadcasting raw messages (kept for compatibility). Job events (`job:*`) are
     *   published with audience `jobs:read`.
     */
    build(events?: ICliEventBus | CliEventBroadcastFn): CliJobsPluginResult {
        const storage = this._storageProvider ?? new InMemoryJobStorageProvider();
        const scheduler = new CliJobScheduler(storage);

        for (const { job, options } of this._jobs) {
            scheduler.register(job, options);
        }

        const explicitBus = resolveCliEventBus(events);
        scheduler.setEventBus(explicitBus);

        const router = createCliJobsController(scheduler, storage);

        return {
            prefix: '/api/v1/qcli/jobs',
            router,
            scheduler,
            installedPlugin: jobsInstalledPlugin,
            setEventBus: (eventBus) => {
                if (!explicitBus) scheduler.setEventBus(eventBus);
            },
        };
    }
}
