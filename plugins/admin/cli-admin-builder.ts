import { Router, RequestHandler, static as expressStatic } from 'express';
import { ICliModule, ICliCommandProcessor, ICliProcessorFilter, ICliEventBus, ICliConfigProvider, ICliConfigStore, CliConfigPermissions, CLI_CONFIG_CHANGED_EVENT } from '@qodalis/cli-server-abstractions';
import { createAuthMiddleware } from './auth/auth-middleware';
import { createAuthController } from './auth/auth-controller';
import { AdminAuthProvider } from './auth/auth-provider';
import { createStatusController, StatusDeps } from './controllers/status-controller';
import { createPluginsController } from './controllers/plugins-controller';
import { createConfigController } from './controllers/config-controller';
import { createLogsController } from './controllers/logs-controller';
import { createWsClientsController, WsClientsDeps } from './controllers/ws-clients-controller';
import { ModuleRegistry, IRegistryLike, IBuilderLike } from './services/module-registry';
import { LogRingBuffer } from './services/log-ring-buffer';
import { StatusSampler } from './services/status-sampler';
import { AdminConfig } from './services/admin-config';
import { createAdminAuthConfigProvider, createLogsConfigProvider } from './services/admin-config-providers';
import { resolveDashboardDir } from './services/dashboard-dir';
import { AdminTheme, AdminThemeDocument, validateAdminTheme } from './services/admin-theme';
import { AdminBranding, AdminBrandingDocument, validateAdminBranding } from './services/admin-branding';
import { adminInstalledPlugin, CliInstalledPlugin } from './services/package-info';
import { ADMIN_MODULE_NAME, CliAdminCommandProcessor } from './commands/admin-command';
import { createDashboardMarketplaceController } from './controllers/dashboard-marketplace-controller';
import { createServerMarketplaceController } from './controllers/server-marketplace-controller';
import { DEFAULT_NPM_REGISTRY, PLUGINS_INSTALL_PERMISSION, SERVER_CORE_PACKAGE, ServerPluginMarketplace } from './services/server-plugin-marketplace';
import { UpdateChecker, UpdateCheckOptions, UpdateCheckScheduler, UPDATES_FILE } from './services/update-checker';
import { createUpdatesController, canReadUpdates } from './controllers/updates-controller';
import type { MarketplaceFetch } from './services/dashboard-marketplace';
import {
    DASHBOARD_INSTALL_PERMISSION,
    DashboardMarketplace,
    DashboardMarketplaceOptions,
} from './services/dashboard-marketplace';
import { DASHBOARD_MODULES_PREFIX } from '@qodalis/cli-server-abstractions';
import { join, resolve, sep } from 'path';
import { DATA_DIR_HINT, QCLI_DATA_DIR_ENV, unwritableFoldersWarning } from './services/plugins-folder';
import * as crypto from 'crypto';

/** The audit plugin's package id (the admin plugin does not depend on it). */
const AUDIT_PLUGIN_ID = '@qodalis/cli-server-plugin-audit';

/** Executor-like interface — the admin plugin only needs to register filters. */
export interface IExecutorLike {
    addFilter(filter: ICliProcessorFilter): void;
}

export interface CliAdminBuildDeps {
    /** The command registry instance. */
    registry: IRegistryLike;
    /** The WebSocket event socket manager. */
    eventSocketManager: WsClientsDeps & {
        broadcastMessage(message: Record<string, unknown>): void;
    };
    /** The CLI builder instance (for reading modules). */
    builder: IBuilderLike;
    /** The command executor service — used to register the module filter for plugin toggling. */
    executor?: IExecutorLike;
    /** Optional broadcast function override for log events. */
    broadcastFn?: (message: Record<string, unknown>) => void;
    /**
     * The server's event bus (`createCliServer().eventBus`): log entries are published on it
     * as `log:entry` (audience `logs:read`) unless `broadcastFn` is set.
     */
    eventBus?: ICliEventBus;
}

export interface CliAdminPluginResult {
    /** Default mount prefix for the API router. */
    prefix: '/api/v1/qcli';
    /** Default mount prefix for the dashboard SPA. */
    dashboardPrefix: '/qcli/admin';
    /** Express router for admin API endpoints. */
    router: Router;
    /** Express router serving the SPA. */
    dashboardRouter: Router;
    /** The auth middleware, in case you need to protect additional routes. */
    authMiddleware: RequestHandler;
    /** The log ring buffer, in case you need to push entries programmatically. */
    logBuffer: LogRingBuffer;
    /** Routes that stay public when the users plugin protects the server. */
    publicRoutes: string[];
    /** Samples the status every 15 seconds for `GET /status/history` (stopped by `dispose`). */
    statusSampler: StatusSampler;
    /** Clean up timers and restore console. Call when shutting down. */
    dispose: () => void;
    /** This package, listed among the server's installed plugins by `mountPlugin`. */
    installedPlugin: CliInstalledPlugin;
    /** `config:read` for `GET /config`, `config:write` for `PATCH` (enforced on a protected server). */
    routePermissions: Array<{ path: string; read: string; write: string }>;
    /** The `auth` (read-only), `logs` and `dashboard-plugins` (with the marketplace) config providers, registered with the server's (also by `build`). */
    configProviders: ICliConfigProvider[];
    /**
     * The `admin` terminal command (`status`, `plugins`, `clients`, `logs`), registered by `mountPlugin`; needs
     * `admin:access` on a protected server (`admin logs` also `logs:read`).
     */
    module: ICliModule;
    /**
     * Dashboard plugins from the marketplace (`setMarketplace`), served at `/api/v1/qcli/dashboard/marketplace`;
     * undefined when turned off (`setMarketplace(false)`) or the builder cannot add pages at runtime.
     */
    marketplace?: DashboardMarketplace;
    /**
     * Server plugins from the marketplace (`setMarketplace`, the package of this server's platform), served at
     * `/api/v1/qcli/server/marketplace`; undefined when the marketplace is off or the builder has no runtime plugins.
     */
    serverMarketplace?: ServerPluginMarketplace;
    /** Serves the marketplace plugins' files at `/qcli/modules/<id>/` (mounted by `mountPlugin`). */
    assetRoutes: Array<{ prefix: string; handler: DashboardMarketplace['handler'] }>;
    /** Receives the server's event bus from `mountPlugin` (`dashboard:extensions-changed`), unless `deps.eventBus` was given. */
    setEventBus(eventBus: ICliEventBus): void;
    /**
     * The update checker (`GET /api/v1/qcli/updates`, `POST /updates/check`): every 6 hours, a job of the jobs plugin
     * when one is mounted; undefined when the marketplace is off.
     */
    updates?: UpdateChecker;
    /** The `updates_list` MCP tool (registered by `mountPlugin` when MCP is on). */
    mcpProviders: Array<{ name: string; getTools(): unknown[] }>;
}

/**
 * Fluent builder for configuring the admin dashboard plugin.
 *
 * @example
 * ```ts
 * import { CliAdminBuilder } from '@qodalis/cli-server-plugin-admin';
 *
 * const adminPlugin = new CliAdminBuilder()
 *     .setCredentials('admin', 'secret')
 *     .build({ registry, eventSocketManager, builder });
 *
 * app.use('/api/v1/qcli', adminPlugin.router);
 * ```
 */
export class CliAdminBuilder {
    private readonly _config = new AdminConfig();
    private _jwtSecret?: string;
    private _registeredJobs = 0;
    private _dashboardDir?: string;
    private _enabledFeatures: string[] = [];
    private _authProvider?: AdminAuthProvider;
    private _theme: AdminThemeDocument = validateAdminTheme(undefined);
    private _branding?: AdminBrandingDocument;
    private _configStore?: ICliConfigStore;
    private _marketplace: DashboardMarketplaceOptions | false = {};
    private _updates: UpdateCheckOptions = {};

    /**
     * The periodic check for updates (marketplace plugins, plugins added in code, the server package): `enabled`
     * (default true), `intervalMs` (default 6 hours), `initialDelayMs` (default 60 s after a start). `false` turns the
     * periodic check off; "Check now" (`POST /api/v1/qcli/updates/check`) still works.
     */
    setUpdateChecks(options: UpdateCheckOptions | false): CliAdminBuilder {
        this._updates = options === false ? { enabled: false } : { ...options };
        return this;
    }

    /**
     * Dashboard and server plugins from the marketplace: `url` (default `https://plugins.qodalis.com`), `install`
     * (`verified`, the default: listed versions of verified publishers only; `listed`: any listed version; `off`:
     * browse only), `dir` (dashboard plugins, default `<dataDir>/dashboard-plugins`: the server's `dataDir`, else
     * `QCLI_DATA_DIR`, else `./qcli-data`), `fetch` / `cdns` /
     * `timeoutMs` for the HTTP client, and for server plugins `npmRegistry` and `npm` (the runner). `false` turns the
     * marketplace off (no routes, installed dashboard plugins not loaded). Throws for an invalid url or policy when built.
     */
    setMarketplace(options: DashboardMarketplaceOptions | false): CliAdminBuilder {
        this._marketplace = options === false ? false : { ...options };
        return this;
    }

    /**
     * Set the dashboard's color scheme: the mode (`dark`, `light` or `system`)
     * and color overrides per scheme. Tokens left out keep the dashboard
     * defaults. Values must be plain CSS colors (hex, rgb()/hsl()/oklch(...)
     * or a named color); anything else throws here.
     *
     * @example
     * ```ts
     * builder.setTheme({
     *     mode: 'system',
     *     light: { primary: '#2a6bba', background: '#f1f6fa' },
     *     dark: { primary: '#4f9be0', background: '#0d1823' },
     * });
     * ```
     */
    setTheme(theme: AdminTheme): CliAdminBuilder {
        this._theme = validateAdminTheme(theme);
        return this;
    }

    /**
     * Ship the dashboard under your own name and icon (browser tab, sidebar,
     * sign-in page) and name its terminal. Unset values keep the Qodalis
     * defaults (Qodalis Cli Admin, the Qodalis Solutions logo, Web CLI); a bad
     * value throws here.
     *
     * @example
     * ```ts
     * builder.setBranding({ name: 'RateBell', iconUrl: '/favicon.svg', cliName: 'RateBell CLI' });
     * ```
     */
    setBranding(branding: AdminBranding): CliAdminBuilder {
        this._branding = validateAdminBranding(branding);
        return this;
    }

    /**
     * Authenticate the dashboard through the users plugin
     * (`usersPlugin.serverAuth`): login uses the users auth service and
     * requires the `admin:access` permission (`admin` has it via `*`). The
     * static credentials are then ignored.
     */
    setAuthProvider(provider: AdminAuthProvider): CliAdminBuilder {
        this._authProvider = provider;
        return this;
    }

    /**
     * Where the host application signs users in, shown by the dashboard in external
     * sign-in mode (the users plugin with an external auth adapter) and returned by
     * `GET /api/v1/qcli/auth/mode`. An absolute `http(s)` URL or a root-relative path
     * (`/sign-in`); anything else (e.g. `javascript:` or `//host`) makes `build()` throw.
     *
     * The dashboard sends users back: it fills `{returnTo}` in the URL, or appends
     * `returnTo=`, with the dashboard page they were on (e.g. a terminal link's approval
     * page); after signing in, the host opens that URL with `#token=<bearer token>`.
     */
    setSignInUrl(url: string | undefined): CliAdminBuilder {
        this._config.signInUrl = url;
        return this;
    }

    /**
     * Set admin credentials.
     */
    setCredentials(username: string, password: string): CliAdminBuilder {
        this._config.setCredentials(username, password);
        return this;
    }

    /**
     * Set JWT signing secret. If not set, reads from QCLI_ADMIN_JWT_SECRET
     * env var or generates a random secret.
     */
    setJwtSecret(secret: string): CliAdminBuilder {
        this._jwtSecret = secret;
        this._config.setJwtSecret(secret);
        return this;
    }

    /**
     * Keeps the `logs` config (log buffer size and level) provider's changes in `store` (its own store) instead of the server's default
     * one; the host's store for the provider's id (`config.stores`, `builder.setConfigStore(store, id)`) still wins.
     */
    setConfigStore(store: ICliConfigStore | undefined): CliAdminBuilder {
        this._configStore = store;
        return this;
    }

    /**
     * Set the number of registered jobs (for status endpoint).
     */
    setRegisteredJobs(count: number): CliAdminBuilder {
        this._registeredJobs = count;
        return this;
    }

    /**
     * Set additional enabled features (for status endpoint).
     * Features like 'filesystem' and 'jobs' are auto-detected;
     * use this to add custom features.
     */
    setEnabledFeatures(features: string[]): CliAdminBuilder {
        this._enabledFeatures = features;
        return this;
    }

    /**
     * Build the admin plugin, returning the Express router and auth middleware.
     */
    build(deps: CliAdminBuildDeps): CliAdminPluginResult {
        const { registry, eventSocketManager, builder, executor, broadcastFn, eventBus } = deps;
        this._config.validate();
        // Read on every request: the users plugin sets it when it is mounted (possibly after this build).
        const isExternal = () => !!builder.serverOptions?.externalAuthentication;

        if (!this._authProvider && this._config.usesDefaultCredentials()) {
            console.warn('[qcli-admin] WARNING: Using default admin credentials. Set QCLI_ADMIN_USERNAME and QCLI_ADMIN_PASSWORD environment variables.');
        }

        // Resolve JWT secret: explicit > env var > random
        const secret = this._jwtSecret
            ?? process.env.QCLI_ADMIN_JWT_SECRET
            ?? crypto.randomBytes(32).toString('hex');

        // Create services
        const moduleRegistry = new ModuleRegistry(registry, builder);

        // Register the module registry as a processor filter so that
        // disabled modules' commands are blocked at execution time.
        if (executor) {
            executor.addFilter(moduleRegistry);
        }
        const logBuffer = new LogRingBuffer();

        const broadcast: (msg: Record<string, unknown>) => void =
            broadcastFn
            ?? (eventBus
                ? ({ type, ...data }) => void eventBus.publish(String(type), data, { permission: 'logs:read' })
                : (msg) => eventSocketManager.broadcastMessage(msg));
        logBuffer.setBroadcastFn(broadcast);
        logBuffer.interceptConsole();

        // Create auth middleware
        const authMiddleware = createAuthMiddleware(secret, this._authProvider, isExternal);

        // Create main router
        const router = Router();

        // Auth routes (login is unauthenticated, /me requires auth)
        const authResult = createAuthController(this._config, secret, this._authProvider, isExternal);
        router.use('/auth', authResult.router);

        // Auth is applied per admin route group (not router-wide): this router
        // is mounted at the shared /api/v1/qcli prefix, so an unscoped
        // `router.use(authMiddleware)` would reject requests meant for other
        // plugins mounted at the same prefix (e.g. the users plugin).

        // Status
        const registeredJobs = this._registeredJobs;
        const enabledFeatures = this._enabledFeatures;
        const statusDeps: StatusDeps = {
            getActiveWsConnections: () => eventSocketManager.getClients().length,
            getActiveShellSessions: () => 0,
            getRegisteredCommands: () => registry.processors.length,
            getRegisteredJobs: () => registeredJobs,
            getEnabledFeatures: () => {
                const features: string[] = [...enabledFeatures];
                const hasFilesystem = !!(builder.fileStorageProvider || builder.fileSystemOptions);
                if (hasFilesystem && !features.includes('filesystem')) {
                    features.push('filesystem');
                }
                const hasJobs = registeredJobs > 0 || !!builder.serverOptions?.jobsEnabled;
                if (hasJobs && !features.includes('jobs')) {
                    features.push('jobs');
                }
                // The audit plugin serves the audit log (GET /api/v1/qcli/audit); the users plugin adds it
                const hasAudit = (builder.installedPlugins ?? []).some((p) => p.id === AUDIT_PLUGIN_ID);
                if (hasAudit && !features.includes('audit')) {
                    features.push('audit');
                }
                return features;
            },
        };
        // Status history: sampled every 15 seconds (unref'd timer, stopped by dispose)
        const statusSampler = new StatusSampler(statusDeps);
        statusSampler.start();
        router.use('/status', authMiddleware, createStatusController(statusDeps, statusSampler));

        // Pages plugins add to the dashboard (docs/extensions.md of the dashboard); the dashboard
        // filters them by the user's permissions, each plugin's own API enforces them
        // Dashboard plugins from the marketplace: pages added and removed at runtime, served from this server
        let bus = eventBus;
        let marketplace: DashboardMarketplace | undefined;
        // Kept in the server's data directory unless the marketplace names its own folder
        const dataDir = builder.serverPlugins?.dataDir ?? resolve(process.env[QCLI_DATA_DIR_ENV] || 'qcli-data');
        const explicitDashboardDir = this._marketplace !== false ? this._marketplace.dir : undefined;
        const dashboardPluginsDir = explicitDashboardDir ?? join(dataDir, 'dashboard-plugins');
        const dashboardFolderHint = explicitDashboardDir ? "Set the marketplace's dir to a writable folder" : DATA_DIR_HINT;
        if (this._marketplace !== false && builder.addDashboardExtension && builder.removeDashboardExtension) {
            const add = builder.addDashboardExtension.bind(builder);
            const remove = builder.removeDashboardExtension.bind(builder);
            marketplace = new DashboardMarketplace({ ...this._marketplace, dir: dashboardPluginsDir }, {
                folderHint: dashboardFolderHint,
                extensions: {
                    list: () => (builder.dashboardExtensions ?? []) as ReadonlyArray<{ id: string }>,
                    add: (extension) => void add(extension),
                    remove,
                },
                serverPlugins: () => builder.installedPlugins ?? [],
                audit: () => builder.auditSink,
                publish: (type, data) => {
                    if (bus) void bus.publish(type, data, { permission: 'admin:access' });
                    else eventSocketManager.broadcastMessage({ type, ...data });
                    updates?.refreshInstalled();
                },
                publishConfigChanged: (data) => {
                    if (bus) void bus.publish(CLI_CONFIG_CHANGED_EVENT, data, { permission: CliConfigPermissions.Read });
                    else eventSocketManager.broadcastMessage({ type: CLI_CONFIG_CHANGED_EVENT, ...data });
                },
            });
            marketplace.load();
            router.use('/dashboard/marketplace', authMiddleware, createDashboardMarketplaceController(marketplace));
        }

        // Server plugins from the marketplace: installed with npm into <dataDir>/server-plugins, loaded at the next start
        let serverMarketplace: ServerPluginMarketplace | undefined;
        let serverFolderHint = DATA_DIR_HINT;
        if (this._marketplace !== false && builder.serverPlugins) {
            serverFolderHint = resolve(builder.serverPlugins.dir).startsWith(resolve(builder.serverPlugins.dataDir) + sep)
                ? DATA_DIR_HINT
                : 'Set serverPlugins.dir to a writable folder';
            serverMarketplace = new ServerPluginMarketplace(this._marketplace, {
                plugins: builder.serverPlugins,
                folderHint: serverFolderHint,
                installedPlugins: () => builder.installedPlugins ?? [],
                restart: builder.restart,
                audit: () => builder.auditSink,
                publish: (type, data) => {
                    if (bus) void bus.publish(type, data, { permission: 'admin:access' });
                    else eventSocketManager.broadcastMessage({ type, ...data });
                    updates?.refreshInstalled();
                },
            });
            router.use('/server/marketplace', authMiddleware, createServerMarketplaceController(serverMarketplace));
        }

        // Updates: the marketplace's newer versions and the server package's, checked every 6 hours and on demand
        let updates: UpdateChecker | undefined;
        if (this._marketplace !== false && (marketplace || serverMarketplace)) {
            const fetchFn = this._marketplace.fetch ?? (globalThis as { fetch?: MarketplaceFetch }).fetch;
            if (fetchFn) {
                updates = new UpdateChecker(
                    {
                        dashboard: marketplace,
                        server: serverMarketplace,
                        serverVersion: () => (builder.installedPlugins ?? []).find((p) => p.id === SERVER_CORE_PACKAGE)?.version ?? null,
                        npmRegistry: serverMarketplace?.npmRegistry ?? DEFAULT_NPM_REGISTRY,
                        fetch: fetchFn,
                        timeoutMs: this._marketplace.timeoutMs,
                        notifications: () => builder.notifications,
                        scheduler: () => builder.pluginServices?.get<UpdateCheckScheduler>('jobs.scheduler'),
                        file: join(dataDir, UPDATES_FILE),
                    },
                    this._updates,
                );
                router.use('/updates', authMiddleware, createUpdatesController(updates));
                // After the host's own mounts (the jobs plugin may come later) and the runtime plugins
                const checker = updates;
                setImmediate(() => {
                    void Promise.resolve(builder.serverPlugins?.ready?.()).then(() => checker.start(), () => checker.start());
                });
            }
        }

        // One WARNING at startup when installing would fail: a folder that cannot be created or written
        const writableFolders: Array<{ dir: string; hint: string }> = [];
        if (marketplace && marketplace.install !== 'off') writableFolders.push({ dir: marketplace.dir, hint: dashboardFolderHint });
        if (serverMarketplace && serverMarketplace.install !== 'off' && builder.serverPlugins?.enabled) {
            writableFolders.push({ dir: builder.serverPlugins.dir, hint: serverFolderHint });
        }
        const folderWarning = unwritableFoldersWarning(writableFolders);
        if (folderWarning) console.warn(folderWarning);

        router.get('/dashboard/extensions', authMiddleware, (_req, res) => {
            res.setHeader('Cache-Control', 'no-cache');
            const extensions = (builder.dashboardExtensions ?? []) as ReadonlyArray<{ id: string }>;
            res.json({
                extensions: marketplace
                    ? extensions.map((e) => {
                          const pkg = marketplace!.packageOf(e.id);
                          return pkg ? { ...e, source: 'marketplace', package: pkg } : e;
                      })
                    : extensions,
            });
        });

        // Plugins
        router.use('/plugins', authMiddleware, createPluginsController(moduleRegistry, () => builder.installedPlugins ?? []));

        // Config: the server's config providers (builder.config), with the plugin's own
        const authMode = () => (this._authProvider ? (isExternal() ? 'external' : 'users') : 'password') as 'password' | 'users' | 'external';
        const configProviders: ICliConfigProvider[] = [
            createAdminAuthConfigProvider(this._config, authMode, () => !!this._jwtSecret || !!process.env.QCLI_ADMIN_JWT_SECRET),
            createLogsConfigProvider(logBuffer).setStore(this._configStore),
            // The dashboard plugins' settings: the host's store for `dashboard-plugins`, else the default store
            ...(marketplace ? [marketplace.config] : []),
        ];
        for (const provider of configProviders) {
            if (builder.addConfigProvider && !builder.configProviders?.some((p) => p.id === provider.id)) {
                builder.addConfigProvider(provider);
            }
        }
        router.use('/config', authMiddleware, createConfigController(() => builder.config));

        // Logs
        router.use('/logs', authMiddleware, createLogsController(logBuffer));

        // WebSocket clients
        router.use('/ws/clients', authMiddleware, createWsClientsController(eventSocketManager));

        // Dashboard SPA static file serving
        const dashboardRouter = Router();
        const dashboardDistDir = resolveDashboardDir(this._dashboardDir);

        // Color scheme and branding, read by the dashboard before its first render
        // (public, like the dashboard itself: the login page uses it too)
        const themeJson = JSON.stringify(this._branding ? { ...this._theme, branding: this._branding } : this._theme);
        dashboardRouter.get('/theme.json', (_req, res) => {
            res.set('Cache-Control', 'no-cache');
            res.type('application/json').send(themeJson);
        });

        if (dashboardDistDir) {
            dashboardRouter.use(expressStatic(dashboardDistDir));

            // SPA fallback: serve index.html for all non-file routes
            dashboardRouter.get('*', (_req, res) => {
                res.sendFile(join(dashboardDistDir, 'index.html'));
            });
        } else {
            dashboardRouter.get('*', (_req, res) => {
                res.status(404).json({
                    error: 'Admin dashboard not found. Ensure the package was built with "npm run copy-dashboard" or install @qodalis/cli-server-dashboard.',
                });
            });
        }

        const dispose = () => {
            updates?.stop();
            clearInterval(authResult.cleanupInterval);
            statusSampler.stop();
            logBuffer.restoreConsole();
        };

        const adminCommand = new CliAdminCommandProcessor({
            statusDeps,
            sampler: statusSampler,
            moduleRegistry,
            logBuffer,
            clients: eventSocketManager,
            installedPlugins: () => builder.installedPlugins ?? [],
            marketplace,
            serverMarketplace,
            restart: builder.restart,
        });

        return {
            prefix: '/api/v1/qcli',
            dashboardPrefix: '/qcli/admin',
            router,
            dashboardRouter,
            authMiddleware,
            logBuffer,
            statusSampler,
            publicRoutes: ['POST /api/v1/qcli/auth/login', 'GET /api/v1/qcli/auth/mode'],
            dispose,
            installedPlugin: adminInstalledPlugin,
            routePermissions: [
                { path: '/api/v1/qcli/config', read: CliConfigPermissions.Read, write: CliConfigPermissions.Write },
                { path: '/api/v1/qcli/dashboard/marketplace', read: 'admin:access', write: DASHBOARD_INSTALL_PERMISSION },
                { path: '/api/v1/qcli/server/marketplace', read: 'admin:access', write: PLUGINS_INSTALL_PERMISSION },
            ],
            configProviders,
            module: {
                name: ADMIN_MODULE_NAME,
                version: adminInstalledPlugin.version ?? '1.0.0',
                description: 'Server administration from the terminal: status, command modules, WebSocket clients, logs',
                author: { name: 'Qodalis', email: 'nicolae.lupei@qodalis.com' },
                icon: '🛠️',
                processors: [adminCommand],
            },
            marketplace,
            serverMarketplace,
            assetRoutes: marketplace ? [{ prefix: DASHBOARD_MODULES_PREFIX, handler: marketplace.handler }] : [],
            setEventBus: (eventBus: ICliEventBus) => {
                bus ??= eventBus;
            },
            updates,
            mcpProviders: updates ? [updatesMcpProvider(updates)] : [],
        };
    }

    /**
     * Set the path to the dashboard dist directory.
     * If not set, the builder will try to resolve it automatically.
     */
    setDashboardDir(dir: string): CliAdminBuilder {
        this._dashboardDir = dir;
        return this;
    }
}

/** `updates_list`: the update checker's last result (`check: true` checks first). */
function updatesMcpProvider(checker: UpdateChecker) {
    return {
        name: 'updates',
        getTools: () => [
            {
                name: 'updates_list',
                description:
                    'List the available updates: dashboard and server plugins installed from the marketplace with a newer version, plugins added in code with a newer package, and the server package; check: true asks the marketplace first',
                inputSchema: {
                    type: 'object' as const,
                    properties: { check: { type: 'boolean' as const, description: 'Check now instead of answering the last result' } },
                    required: [] as string[],
                    additionalProperties: false as const,
                },
                requiredPermissions: [] as string[],
                annotations: { readOnlyHint: true },
                call: async (args: Record<string, unknown>, context: { auth?: { permissions?: string[] } }) => {
                    if (context.auth && !canReadUpdates(context.auth.permissions ?? [])) {
                        return { text: 'forbidden: missing permission updates:read', isError: true };
                    }
                    const result = args.check === true ? await checker.check() : checker.result();
                    const lines = [...result.dashboardPlugins, ...result.serverPlugins, ...result.codePlugins, ...(result.server?.updateAvailable ? [result.server] : [])].map(
                        (i) => `${i.kind} ${i.package}: ${i.current ?? '?'} -> ${i.latest ?? '?'} (${i.canUpdate ? 'update from the dashboard' : (i.reason ?? 'update in code')})`,
                    );
                    const text = `${result.count} update(s) available; last checked ${result.checkedAt ?? 'never'}${result.error ? ` (${result.error})` : ''}${lines.length ? `\n${lines.join('\n')}` : ''}`;
                    return { text, structured: { ...result } as Record<string, unknown>, isError: false };
                },
            },
        ],
    };
}
