import { Router, RequestHandler, static as expressStatic } from 'express';
import { ICliModule, ICliCommandProcessor, ICliProcessorFilter } from '@qodalis/cli-server-abstractions';
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
import { AdminConfig } from './services/admin-config';
import { resolveDashboardDir } from './services/dashboard-dir';
import { join } from 'path';
import * as crypto from 'crypto';

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
    /** Clean up timers and restore console. Call when shutting down. */
    dispose: () => void;
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
        const { registry, eventSocketManager, builder, executor, broadcastFn } = deps;

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

        const broadcast = broadcastFn ?? ((msg) => eventSocketManager.broadcastMessage(msg));
        logBuffer.setBroadcastFn(broadcast);
        logBuffer.interceptConsole();

        // Create auth middleware
        const authMiddleware = createAuthMiddleware(secret, this._authProvider);

        // Create main router
        const router = Router();

        // Auth routes (login is unauthenticated, /me requires auth)
        const authResult = createAuthController(this._config, secret, this._authProvider);
        router.use('/auth', authResult.router);

        // Auth is applied per admin route group (not router-wide): this router
        // is mounted at the shared /api/v1/qcli prefix, so an unscoped
        // `router.use(authMiddleware)` would reject requests meant for other
        // plugins mounted at the same prefix (e.g. the users plugin).

        // Status
        const registeredJobs = this._registeredJobs;
        const enabledFeatures = this._enabledFeatures;
        const hasFilesystem = !!(builder.fileStorageProvider || builder.fileSystemOptions);
        const statusDeps: StatusDeps = {
            getActiveWsConnections: () => eventSocketManager.getClients().length,
            getActiveShellSessions: () => 0,
            getRegisteredCommands: () => registry.processors.length,
            getRegisteredJobs: () => registeredJobs,
            getEnabledFeatures: () => {
                const features: string[] = [...enabledFeatures];
                if (hasFilesystem && !features.includes('filesystem')) {
                    features.push('filesystem');
                }
                if (registeredJobs > 0 && !features.includes('jobs')) {
                    features.push('jobs');
                }
                return features;
            },
        };
        router.use('/status', authMiddleware, createStatusController(statusDeps));

        // Plugins
        router.use('/plugins', authMiddleware, createPluginsController(moduleRegistry));

        // Config
        router.use('/config', authMiddleware, createConfigController(this._config));

        // Logs
        router.use('/logs', authMiddleware, createLogsController(logBuffer));

        // WebSocket clients
        router.use('/ws/clients', authMiddleware, createWsClientsController(eventSocketManager));

        // Dashboard SPA static file serving
        const dashboardRouter = Router();
        const dashboardDistDir = resolveDashboardDir(this._dashboardDir);

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
            clearInterval(authResult.cleanupInterval);
            logBuffer.restoreConsole();
        };

        return {
            prefix: '/api/v1/qcli',
            dashboardPrefix: '/qcli/admin',
            router,
            dashboardRouter,
            authMiddleware,
            logBuffer,
            publicRoutes: ['POST /api/v1/qcli/auth/login'],
            dispose,
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
