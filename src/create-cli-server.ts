import express, { Express, Router } from 'express';
import cors from 'cors';
import { CliCommandRegistry, CliCommandExecutorService, CliEventSocketManager, CliLogSocketManager } from './services';
import { CliBuilder } from './extensions';
import { createCliController } from './controllers/cli-controller';
import { createCliVersionController } from './controllers/cli-version-controller';
import { createFilesystemRouter } from './controllers/filesystem-controller';
import { OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { DataExplorerExecutor, createDataExplorerController } from '@qodalis/cli-server-plugin-data-explorer';
import { createLogger } from './utils/logger';

/**
 * Generic interface for plugin results that can be auto-mounted.
 * Plugins expose a `prefix` and `router`; some also have a
 * `dashboardPrefix` / `dashboardRouter` pair.
 */
export interface MountablePlugin {
    prefix: string;
    router: Router;
    dashboardPrefix?: string;
    dashboardRouter?: Router;
}

const logger = createLogger('Server');

/** Options for creating a standalone CLI server instance. */
export interface CliServerOptions {
    /** Base path for CLI routes. Defaults to '/api/qcli'. */
    basePath?: string;
    /** CORS configuration. Pass `true` for permissive, `false` to disable, or a cors options object. */
    cors?: boolean | cors.CorsOptions;
    /** Configure processors via the builder. */
    configure?: (builder: CliBuilder) => void;
}

/**
 * Creates a fully configured Express app with CLI routes mounted.
 *
 * Use this for standalone server mode. For integration into an existing
 * Express app, use `createCliController` directly instead.
 */
export interface CliServerResult {
    app: Express;
    registry: CliCommandRegistry;
    builder: CliBuilder;
    executor: CliCommandExecutorService;
    eventSocketManager: CliEventSocketManager;
    logSocketManager: CliLogSocketManager;
    /**
     * Mount a plugin using its built-in prefix.
     * Reads `prefix` and `router` from the plugin result, and optionally
     * `dashboardPrefix` / `dashboardRouter` for plugins that serve a UI.
     *
     * @example
     * ```ts
     * const result = createCliServer();
     * result.mountPlugin(jobsPlugin);
     * result.mountPlugin(adminPlugin);
     * ```
     */
    mountPlugin(plugin: MountablePlugin): void;
}

export function createCliServer(options: CliServerOptions = {}): CliServerResult {
    const { basePath = '/api/qcli', cors: corsOption = true, configure } = options;

    const app = express();

    if (corsOption !== false) {
        app.use(cors(corsOption === true ? undefined : corsOption));
    }

    app.use(express.json());

    const registry = new CliCommandRegistry();
    const builder = new CliBuilder(registry);

    if (configure) {
        configure(builder);
    }

    const executor = new CliCommandExecutorService(registry);

    // Version discovery endpoint
    app.use('/api/qcli', createCliVersionController());

    // API v1 routes
    app.use('/api/v1/qcli', createCliController(registry, executor));

    // Custom basePath fallback (when user overrides the default)
    if (basePath !== '/api/v1/qcli') {
        app.use(basePath, createCliController(registry, executor));
    }

    // Filesystem API — provider-based
    let fsProvider = builder.fileStorageProvider;
    if (!fsProvider && builder.fileSystemOptions) {
        // Backward compatibility: create OsFileStorageProvider from old-style options
        fsProvider = new OsFileStorageProvider(builder.fileSystemOptions);
    }
    if (fsProvider) {
        app.use('/api/qcli/fs', createFilesystemRouter(fsProvider));
    }

    // Data Explorer API
    const deBuilder = builder.dataExplorerBuilder;
    if (deBuilder && deBuilder.registry.size > 0) {
        const deExecutor = new DataExplorerExecutor(deBuilder.registry);
        app.use('/api/qcli/data-explorer', createDataExplorerController(deBuilder.registry, deExecutor));
    }

    const eventSocketManager = new CliEventSocketManager();
    const logSocketManager = new CliLogSocketManager();

    logger.info('CLI server created with %d processors', registry.processors.length);

    const mountPlugin = (plugin: MountablePlugin) => {
        app.use(plugin.prefix, plugin.router);
        if (plugin.dashboardPrefix && plugin.dashboardRouter) {
            app.use(plugin.dashboardPrefix, plugin.dashboardRouter);
        }
    };

    return { app, registry, builder, executor, eventSocketManager, logSocketManager, mountPlugin };
}
