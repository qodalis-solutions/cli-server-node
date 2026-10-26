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
import { ICliServerAuth, isOriginAllowed, isSameOrigin, trustedProxyHops } from './auth/cli-server-auth';
import { createServerAuthGate, normalizePath } from './auth/cli-server-auth-gate';
import { CliShellOptions } from './services/cli-shell-options';
import { ShellCapabilities } from './controllers/cli-version-controller';
import {
    CliMcpOptions,
    CommandsMcpToolProvider,
    DataExplorerMcpToolProvider,
    FilesystemMcpToolProvider,
    JobsMcpToolProvider,
    McpToolProvider,
    MCP_SERVER_NAME,
    MCP_SERVER_VERSION,
    ServerMcpToolProvider,
    createMcpController,
    createMcpPreGate,
    resolveMcpOptions,
} from './mcp';
import type { CliJobScheduler } from '@qodalis/cli-server-plugin-jobs';

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
    /** MCP tool providers contributed by the plugin (used when the `mcp` option is on). */
    mcpProviders?: McpToolProvider[];
    /** Job scheduler (the jobs plugin): enables the `jobs_*` MCP tools. */
    scheduler?: unknown;
}

/** MCP extension point of a server instance. */
export interface CliServerMcp {
    /** True when the MCP endpoint is enabled. */
    readonly enabled: boolean;
    /** The endpoint path (`{basePath}/mcp`). */
    readonly path: string;
    /**
     * Registers a tool provider. On a name collision built-in feature tools win,
     * then providers in registration order, then command tools.
     */
    addProvider(provider: McpToolProvider): void;
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
     * Behind reverse proxies: the number of trusted proxy hops (`true` = 1,
     * `false`/0 = none, the default). The client IP (Express `req.ip`, the
     * shell's per-address limits) is the `X-Forwarded-For` entry at index
     * `len - hops` (with one hop, the rightmost entry, appended by the trusted
     * proxy); the leftmost entry when the list is shorter, the socket address
     * when the header is absent. `X-Forwarded-Proto`/`-Host` are honoured too.
     */
    trustProxy?: boolean | number;
    /**
     * Auth provider protecting the whole server (e.g. `usersPlugin.serverAuth`).
     * Can also be installed later with `setAuth()` or by `mountPlugin(usersPlugin)`.
     */
    auth?: ICliServerAuth;
    /**
     * MCP endpoint (`POST {basePath}/mcp`, off by default): AI clients call the
     * registered commands as MCP tools. `true` enables it with defaults; the object
     * form sets an allow/deny list of tools, a static bearer `token` (only without
     * an auth provider) and `instructions` returned by `initialize`.
     */
    mcp?: boolean | CliMcpOptions;
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
    /** MCP endpoint: register tool providers (`mcp.addProvider(p)`). */
    mcp: CliServerMcp;
}

export function createCliServer(options: CliServerOptions = {}): CliServerResult {
    const { basePath = '/api/qcli', cors: corsOption, configure, allowedOrigins, enableShell = false, shell, trustProxy = false } = options;
    if (shell && !enableShell) {
        logger.warn('shell options are set but enableShell is false: the shell stays disabled');
    }

    const app = express();
    const proxyHops = trustedProxyHops(trustProxy);
    if (proxyHops > 0) {
        app.set('trust proxy', proxyHops);
    }

    if (corsOption === true) {
        app.use(cors());
    } else if (corsOption && typeof corsOption === 'object') {
        app.use(cors(corsOption));
    } else if (corsOption === undefined && allowedOrigins && allowedOrigins.length > 0) {
        // Same-origin requests (e.g. the bundled admin dashboard) are always allowed.
        app.use(
            cors((req, callback) => {
                const origin = req.headers.origin;
                callback(null, {
                    origin: isOriginAllowed(origin, allowedOrigins) || isSameOrigin(origin, req as express.Request),
                });
            }),
        );
    }

    const mcpOptions = resolveMcpOptions(options.mcp);
    const mcpPath = `${normalizePath(basePath)}/mcp`;
    if (mcpOptions?.token && options.auth?.protectServer) {
        logger.warn('mcp.token is ignored: the auth provider protects the MCP endpoint');
    }
    if (mcpOptions) {
        // DNS-rebinding protection and 405s come first, before authentication
        app.use(mcpPath, createMcpPreGate({ allowedOrigins, trustProxy }));
    }

    // The MCP endpoint reads its own body (JSON-RPC parse errors are JSON-RPC responses)
    const jsonParser = express.json({ limit: '1mb' });
    app.use((req, res, next) => {
        if (mcpOptions && normalizePath(req.path) === mcpPath) {
            next();
            return;
        }
        jsonParser(req, res, next);
    });
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
            mcpPaths: mcpOptions ? [mcpPath] : [],
        }),
    );

    if (configure) {
        configure(builder);
    }

    const executor = new CliCommandExecutorService(registry);

    const eventSocketManager = new CliEventSocketManager({ enableShell, shell, allowedOrigins, trustProxy });
    const logSocketManager = new CliLogSocketManager({ allowedOrigins, trustProxy });
    const shellCapabilities = (): ShellCapabilities => {
        const mode = eventSocketManager.shellAuthMode;
        return mode ? { shell: true, shellAuth: mode } : { shell: false };
    };

    // MCP tool providers, in priority order: built-in features, plugins/host (registration order), then commands
    const mcpFeatureProviders: McpToolProvider[] = [];
    const commandsMcpProvider = new CommandsMcpToolProvider(registry, executor);
    const mcpFeatures = new Set<string>(['commands']);
    if (mcpOptions) {
        mcpFeatures.add('mcp');
        mcpFeatureProviders.push(
            new ServerMcpToolProvider({
                registry,
                serverName: MCP_SERVER_NAME,
                version: MCP_SERVER_VERSION,
                capabilities: () => ({ ...shellCapabilities() }),
                features: () => {
                    const features = [...mcpFeatures];
                    if (eventSocketManager.shellAuthMode) features.push('shell');
                    if (serverAuth?.protectServer) features.push('users');
                    return features;
                },
            }),
        );
        app.use(
            mcpPath,
            createMcpController({
                providers: () => [...mcpFeatureProviders, ...builder.mcpToolProviders, commandsMcpProvider],
                mcp: mcpOptions,
                getAuth: () => serverAuth,
                allowedOrigins,
                trustProxy,
            }),
        );
    }

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
        app.use('/api/qcli/fs', createFilesystemRouter(fsProvider, builder.fileSystemApiOptions));
        mcpFeatureProviders.push(new FilesystemMcpToolProvider(fsProvider));
        mcpFeatures.add('filesystem');
    }

    // Data Explorer API
    const deBuilder = builder.dataExplorerBuilder;
    if (deBuilder && deBuilder.registry.size > 0) {
        const deExecutor = new DataExplorerExecutor(deBuilder.registry);
        app.use('/api/qcli/data-explorer', createDataExplorerController(deBuilder.registry, deExecutor));
        mcpFeatureProviders.push(new DataExplorerMcpToolProvider(deBuilder.registry, deExecutor));
        mcpFeatures.add('data-explorer');
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
        if (isJobScheduler(plugin.scheduler) && !mcpFeatures.has('jobs')) {
            mcpFeatureProviders.push(new JobsMcpToolProvider(plugin.scheduler));
            mcpFeatures.add('jobs');
        }
        for (const provider of plugin.mcpProviders ?? []) {
            builder.addMcpToolProvider(provider);
        }
    };

    const mcp: CliServerMcp = {
        enabled: !!mcpOptions,
        path: mcpPath,
        addProvider: (provider) => {
            builder.addMcpToolProvider(provider);
        },
    };

    return { app, registry, builder, executor, eventSocketManager, logSocketManager, mountPlugin, setAuth, mcp };
}

/** Duck-typed check (the jobs plugin may be a different package copy than the server's). */
function isJobScheduler(value: unknown): value is CliJobScheduler {
    const s = value as Partial<Record<keyof CliJobScheduler, unknown>> | undefined;
    return (
        !!s &&
        typeof s.getAll === 'function' &&
        typeof s.get === 'function' &&
        typeof s.getRegistration === 'function' &&
        typeof s.triggerAsync === 'function' &&
        typeof s.cancelCurrentAsync === 'function'
    );
}
