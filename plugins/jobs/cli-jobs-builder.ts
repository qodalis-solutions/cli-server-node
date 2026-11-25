import {
    ICliJob,
    ICliConfigProvider,
    ICliConfigStore,
    CliJobOptions,
    ICliJobStorageProvider,
    CliInstalledPlugin,
    CliEventBroadcastFn,
    CliDashboardModulePage,
    ICliEventBus,
    resolveCliEventBus,
} from '@qodalis/cli-server-abstractions';
import { Router } from 'express';
import { CliJobScheduler, CliJobsOptions } from './cli-job-scheduler';
import { InMemoryJobStorageProvider } from './in-memory-job-storage-provider';
import { createCliJobsController } from './cli-jobs-controller';
import { jobsInstalledPlugin } from './package-info';
import { jobsDashboardPage } from './dashboard-page';
import { createJobsConfigProvider } from './jobs-config-provider';

export interface CliJobsPluginResult {
    /** Default mount prefix for this plugin. */
    prefix: '/api/v1/qcli/jobs';
    /** Express router for the jobs API. */
    router: Router;
    /** The job scheduler instance. Call `start()` / `stop()` to manage its lifecycle. */
    scheduler: CliJobScheduler;
    /** This package, listed among the server's installed plugins by `mountPlugin`. */
    installedPlugin: CliInstalledPlugin;
    /** The admin dashboard's Jobs page and Overview cards (`/qcli/modules/jobs`), when the package carries its build. */
    dashboardPages: CliDashboardModulePage[];
    /** The `jobs` config provider (history retention defaults), registered by `mountPlugin`. */
    configProviders: ICliConfigProvider[];
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
    private readonly _options: CliJobsOptions;
    private _dashboardDir?: string | false;
    private _configStore?: ICliConfigStore;

    /**
     * @param options The plugin's options, e.g. the history retention:
     *   `new CliJobsBuilder({ history: { maxAge: '30d', maxRunsPerJob: 500 } })`.
     */
    constructor(options: CliJobsOptions = {}) {
        this._options = { ...options };
    }

    /**
     * Set the history retention (opt-in): `maxAge`, `maxRunsPerJob`, `failedMaxAge`,
     * `failedMaxRunsPerJob` and `pruneInterval` (default 1 day), applied by the built-in
     * `jobs:prune-history` job. A job's own `history` options replace them for that job.
     */
    setHistory(history: CliJobsOptions['history']): CliJobsBuilder {
        this._options.history = history;
        return this;
    }

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
     * Keeps the `jobs` config provider's changes in `store` (its own store) instead of the server's default
     * one; the host's store for the provider's id (`config.stores`, `builder.setConfigStore(store, id)`) still wins.
     */
    setConfigStore(store: ICliConfigStore | undefined): CliJobsBuilder {
        this._configStore = store;
        return this;
    }

    /**
     * Where the dashboard's Jobs page is (`@qodalis/cli-dashboard-module-jobs`'s build); by default the copy next to
     * the plugin, else the installed package. `false` leaves the page out.
     */
    setDashboardDir(dir: string | false): CliJobsBuilder {
        this._dashboardDir = dir;
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
        const scheduler = new CliJobScheduler(storage, this._options);

        for (const { job, options } of this._jobs) {
            scheduler.register(job, options);
        }
        scheduler.ensureHistoryPruneJob();

        const explicitBus = resolveCliEventBus(events);
        scheduler.setEventBus(explicitBus);

        const router = createCliJobsController(scheduler, storage);
        const page = jobsDashboardPage(this._dashboardDir);

        return {
            prefix: '/api/v1/qcli/jobs',
            router,
            scheduler,
            installedPlugin: jobsInstalledPlugin,
            dashboardPages: page ? [page] : [],
            configProviders: [createJobsConfigProvider(scheduler).setStore(this._configStore)],
            setEventBus: (eventBus) => {
                if (!explicitBus) scheduler.setEventBus(eventBus);
            },
        };
    }
}
