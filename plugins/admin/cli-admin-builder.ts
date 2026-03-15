import { Router, RequestHandler } from 'express';
import { ICliModule, ICliCommandProcessor } from '@qodalis/cli-server-abstractions';
import { createAuthMiddleware } from './auth/auth-middleware';
import { createAuthController } from './auth/auth-controller';
import { setDefaultSecret } from './auth/jwt-service';
import { createStatusController, StatusDeps } from './controllers/status-controller';
import { createPluginsController } from './controllers/plugins-controller';
import { createConfigController } from './controllers/config-controller';
import { createLogsController } from './controllers/logs-controller';
import { createWsClientsController, WsClientsDeps } from './controllers/ws-clients-controller';
import { ModuleRegistry, IRegistryLike, IBuilderLike } from './services/module-registry';
import { LogRingBuffer } from './services/log-ring-buffer';
import { AdminConfig } from './services/admin-config';

export interface CliAdminBuildDeps {
    /** The command registry instance. */
    registry: IRegistryLike;
    /** The WebSocket event socket manager. */
    eventSocketManager: WsClientsDeps & {
        broadcastMessage(message: Record<string, unknown>): void;
    };
    /** The CLI builder instance (for reading modules). */
    builder: IBuilderLike;
    /** Optional broadcast function override for log events. */
    broadcastFn?: (message: Record<string, unknown>) => void;
}

export interface CliAdminPluginResult {
    /** Express router — mount at `/api/v1/qcli`. */
    router: Router;
    /** The auth middleware, in case you need to protect additional routes. */
    authMiddleware: RequestHandler;
    /** The log ring buffer, in case you need to push entries programmatically. */
    logBuffer: LogRingBuffer;
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
     * Build the admin plugin, returning the Express router and auth middleware.
     */
    build(deps: CliAdminBuildDeps): CliAdminPluginResult {
        const { registry, eventSocketManager, builder, broadcastFn } = deps;

        // Set up JWT secret if provided
        if (this._jwtSecret) {
            setDefaultSecret(this._jwtSecret);
        }

        // Create services
        const moduleRegistry = new ModuleRegistry(registry, builder);
        const logBuffer = new LogRingBuffer();

        const broadcast = broadcastFn ?? ((msg) => eventSocketManager.broadcastMessage(msg));
        logBuffer.setBroadcastFn(broadcast);
        logBuffer.interceptConsole();

        // Create auth middleware
        const authMiddleware = createAuthMiddleware(this._jwtSecret);

        // Create main router
        const router = Router();

        // Auth routes (login is unauthenticated, /me requires auth)
        router.use('/auth', createAuthController(this._config, this._jwtSecret));

        // Apply auth middleware to all routes below
        router.use(authMiddleware);

        // Status
        const registeredJobs = this._registeredJobs;
        const statusDeps: StatusDeps = {
            getActiveWsConnections: () => eventSocketManager.getClients().length,
            getActiveShellSessions: () => 0, // Shell sessions are managed internally
            getRegisteredCommands: () => registry.processors.length,
            getRegisteredJobs: () => registeredJobs,
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

        return { router, authMiddleware, logBuffer };
    }
}
