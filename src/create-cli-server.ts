import express, { Express } from 'express';
import cors from 'cors';
import { CliCommandRegistry, CliCommandExecutorService, CliEventSocketManager, CliLogSocketManager } from './services';
import { CliBuilder } from './extensions';
import { createCliController } from './controllers/cli-controller';
import { createCliControllerV2 } from './controllers/cli-controller-v2';
import { createCliVersionController } from './controllers/cli-version-controller';
import { createFilesystemRouter } from './controllers/filesystem-controller';
import { OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { DataExplorerExecutor, createDataExplorerController } from '@qodalis/cli-server-plugin-data-explorer';

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
export function createCliServer(options: CliServerOptions = {}): {
    app: Express;
    registry: CliCommandRegistry;
    builder: CliBuilder;
    eventSocketManager: CliEventSocketManager;
    logSocketManager: CliLogSocketManager;
} {
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

    // API v2 routes
    app.use('/api/v2/qcli', createCliControllerV2(registry, executor));

    // Custom basePath fallback (when user overrides the default)
    if (basePath !== '/api/v1/qcli' && basePath !== '/api/v2/qcli') {
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

    return { app, registry, builder, eventSocketManager, logSocketManager };
}
