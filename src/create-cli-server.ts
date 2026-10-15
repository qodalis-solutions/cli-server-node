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
import { ICliServerAuth, isOriginAllowed } from './auth/cli-server-auth';
import { createServerAuthGate, normalizePath } from './auth/cli-server-auth-gate';
import { CliShellOptions } from './services/cli-shell-options';
import { ShellCapabilities } from './controllers/cli-version-controller';

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
    /**
     * Auth provider exposed by the users plugin. Mounting such a plugin
     * installs it: when `protectServer` is on, every server route and socket
     * then requires a users session.
     */
    serverAuth?: ICliServerAuth;
    /** Routes that stay public under server protection, as `"METHOD /path"` (e.g. a plugin's login). */
    publicRoutes?: string[];
}

const logger = createLogger('Server');

/** Options for creating a standalone CLI server instance. */
export interface CliServerOptions {
    /** Base path for CLI routes. Defaults to '/api/qcli'. */
    basePath?: string;
    /**
     * CORS configuration. `true` = permissive (any origin, no credentials),
     * `false` = disabled, or a cors options object. When omitted, CORS is
     * enabled only for `allowedOrigins` (disabled if none are set).
     */
    cors?: boolean | cors.CorsOptions;
    /**
     * Origins allowed for CORS and WebSocket upgrades (exact match; `http://host:*`
     * matches any port). Every WS upgrade with an `Origin` header is checked.
     */
    allowedOrigins?: string[];
    /**
     * Accept interactive shell WebSocket sessions (default false). When enabled,
     * access is decided by one mode: users plugin mounted (ticket +
     * `shell:execute`), `shell.token`, `shell.authorize` or `shell.allowAnonymous`.
     * With none of them the shell is locked (every connection closed with 4401).
     */
    enableShell?: boolean;
    /** Remote shell security: access mode, limits, timeouts, cwd, shell binary, environment. */
    shell?: CliShellOptions;
    /**
     * Auth provider protecting the whole server (e.g. `usersPlugin.serverAuth`).
     * Can also be installed later with `setAuth()` or by `mountPlugin(usersPlugin)`.
     */
    auth?: ICliServerAuth;
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
    /** Installs (or removes) the auth provider protecting server routes and sockets. */
    setAuth(auth: ICliServerAuth | undefined): void;
}

export function createCliServer(options: CliServerOptions = {}): CliServerResult {
    const { basePath = '/api/qcli', cors: corsOption, configure, allowedOrigins, enableShell = false, shell } = options;
    if (shell && !enableShell) {
        logger.warn('shell options are set but enableShell is false: the shell stays disabled');
    }

    const app = express();

    if (corsOption === true) {
        app.use(cors());
    } else if (corsOption && typeof corsOption === 'object') {
        app.use(cors(corsOption));
    } else if (corsOption === undefined && allowedOrigins && allowedOrigins.length > 0) {
        app.use(
            cors({
                origin: (origin, callback) => callback(null, isOriginAllowed(origin, allowedOrigins)),
            }),
        );
    }

    app.use(express.json({ limit: '1mb' }));
    // Render body-parser failures (malformed JSON, too large) as JSON `{ error }`
    app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
            const status = err.type === 'entity.too.large' ? 413 : 400;
            res.status(status).json({ error: status === 413 ? 'request body too large' : 'invalid JSON body' });
            return;
        }
        next(err);
    });

    const registry = new CliCommandRegistry();
    const builder = new CliBuilder(registry);

    // Server-wide auth gate (no-op until an auth provider is installed)
    let serverAuth: ICliServerAuth | undefined;
    const publicRoutes = new Set<string>();
    app.use(
        createServerAuthGate(() => serverAuth, {
            registry,
            cliPrefixes: Array.from(new Set(['/api/v1/qcli', normalizePath(basePath)])),
            publicRoutes,
        }),
    );

    if (configure) {
        configure(builder);
    }

    const executor = new CliCommandExecutorService(registry);

    const eventSocketManager = new CliEventSocketManager({ enableShell, shell, allowedOrigins });
    const logSocketManager = new CliLogSocketManager({ allowedOrigins });
    const shellCapabilities = (): ShellCapabilities => {
        const mode = eventSocketManager.shellAuthMode;
        return mode ? { shell: true, shellAuth: mode } : { shell: false };
    };

    // Version discovery endpoint
    app.use('/api/qcli', createCliVersionController({ shellCapabilities }));

    // API v1 routes
    app.use('/api/v1/qcli', createCliController(registry, executor, { shellCapabilities }));

    // Custom basePath fallback (when user overrides the default)
    if (basePath !== '/api/v1/qcli') {
        app.use(basePath, createCliController(registry, executor, { shellCapabilities }));
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

    logger.info('CLI server created with %d processors', registry.processors.length);

    const setAuth = (auth: ICliServerAuth | undefined) => {
        serverAuth = auth;
        eventSocketManager.setAuth(auth);
        logSocketManager.setAuth(auth);
        auth?.attachToServer?.({
            allowedOrigins,
            broadcast: (msg) => eventSocketManager.broadcastMessage(msg),
        });
    };

    if (options.auth) {
        setAuth(options.auth);
    }

    const mountPlugin = (plugin: MountablePlugin) => {
        for (const route of plugin.publicRoutes ?? []) {
            const [method, ...rest] = route.trim().split(/\s+/);
            publicRoutes.add(`${method.toUpperCase()} ${normalizePath(rest.join(' '))}`);
        }
        if (plugin.serverAuth && plugin.serverAuth !== serverAuth) {
            setAuth(plugin.serverAuth);
        }
        app.use(plugin.prefix, plugin.router);
        if (plugin.dashboardPrefix && plugin.dashboardRouter) {
            app.use(plugin.dashboardPrefix, plugin.dashboardRouter);
        }
    };

    return { app, registry, builder, executor, eventSocketManager, logSocketManager, mountPlugin, setAuth };
}
