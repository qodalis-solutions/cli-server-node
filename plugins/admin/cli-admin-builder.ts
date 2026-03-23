import { Router, RequestHandler, static as expressStatic } from 'express';
import { ICliModule, ICliCommandProcessor, ICliProcessorFilter } from '@qodalis/cli-server-abstractions';
import { createAuthMiddleware } from './auth/auth-middleware';
import { createAuthController } from './auth/auth-controller';
import { createStatusController, StatusDeps } from './controllers/status-controller';
import { createPluginsController } from './controllers/plugins-controller';
import { createConfigController } from './controllers/config-controller';
import { createLogsController } from './controllers/logs-controller';
import { createWsClientsController, WsClientsDeps } from './controllers/ws-clients-controller';
import { ModuleRegistry, IRegistryLike, IBuilderLike } from './services/module-registry';
import { LogRingBuffer } from './services/log-ring-buffer';
import { AdminConfig } from './services/admin-config';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
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
    /** Express router — mount at `/api/v1/qcli`. */
    router: Router;
    /** Express router serving the SPA at `/qcli/admin`. */
    dashboardRouter: Router;
    /** The auth middleware, in case you need to protect additional routes. */
    authMiddleware: RequestHandler;
    /** The log ring buffer, in case you need to push entries programmatically. */
    logBuffer: LogRingBuffer;
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
        const authMiddleware = createAuthMiddleware(secret);

        // Create main router
        const router = Router();

        // Auth routes (login is unauthenticated, /me requires auth)
        const authResult = createAuthController(this._config, secret);
        router.use('/auth', authResult.router);

        // Apply auth middleware to all routes below
        router.use(authMiddleware);

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
        router.use('/status', createStatusController(statusDeps));

        // Plugins
        router.use('/plugins', createPluginsController(moduleRegistry));

        // Config
        router.use('/config', createConfigController(this._config));

        // Logs
        router.use('/logs', createLogsController(logBuffer));

        // WebSocket clients
        router.use('/ws/clients', createWsClientsController(eventSocketManager));

        // Dashboard SPA static file serving
        const dashboardRouter = Router();
        const dashboardDistDir = this._resolveDashboardDir();

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

        return { router, dashboardRouter, authMiddleware, logBuffer, dispose };
    }

    /**
     * Set the path to the dashboard dist directory.
     * If not set, the builder will try to resolve it automatically.
     */
    setDashboardDir(dir: string): CliAdminBuilder {
        this._dashboardDir = dir;
        return this;
    }

    /**
     * Resolve the dashboard dist directory. Looks for:
     * 1. Explicitly set path
     * 2. @qodalis/cli-server-dashboard/dist (npm package)
     * 3. Relative paths from this file and cwd (development)
     */
    private _resolveDashboardDir(): string | null {
        // Explicit override
        if (this._dashboardDir && existsSync(this._dashboardDir)) {
            return resolve(this._dashboardDir);
        }

        // Try bundled dashboard directory (embedded in this package)
        const bundledPath = resolve(__dirname, '..', 'dashboard');
        if (existsSync(bundledPath)) return bundledPath;

        // Try resolving from node_modules (published package — legacy fallback)
        try {
            const pkgDir = require.resolve('@qodalis/cli-server-dashboard/package.json');
            const distDir = join(pkgDir, '..', 'dist');
            if (existsSync(distDir)) return resolve(distDir);
        } catch {
            // Package not installed
        }

        // Try relative path from this file (development)
        const devPath = resolve(__dirname, '../../../../cli-server-dashboard/dist');
        if (existsSync(devPath)) return devPath;

        // Try relative path from cwd (workspace root)
        const cwdPath = resolve(process.cwd(), '../cli-server-dashboard/dist');
        if (existsSync(cwdPath)) return cwdPath;

        return null;
    }
}
