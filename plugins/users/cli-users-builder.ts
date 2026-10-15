import { Router, json, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthAdapter, UsersBroadcastFn, UsersModuleOptions } from './models';
import {
    ICliUserStore,
    ICliSessionStore,
    ICliCredentialStore,
    ICliAuditStore,
    ICliGroupStore,
} from './stores/interfaces';
import { InMemoryUserStore } from './stores/in-memory-user-store';
import { InMemorySessionStore } from './stores/in-memory-session-store';
import { InMemoryCredentialStore } from './stores/in-memory-credential-store';
import { InMemoryAuditStore } from './stores/in-memory-audit-store';
import { InMemoryGroupStore } from './stores/in-memory-group-store';
import { AuthService } from './services/auth-service';
import { DirectoryService } from './services/directory-service';
import { createAuthMiddleware, RequestAuthenticator } from './middleware/auth-middleware';
import { UsersServerAuth } from './server-auth';
import { RateLimiter, clientIp } from './security';
import { randomInt } from 'crypto';
import { createUsersController } from './controllers/users-controller';
import { createSessionsController } from './controllers/sessions-controller';
import { createGroupsController } from './controllers/groups-controller';
import { createAuditController } from './controllers/audit-controller';
import { errorHandler, HttpError } from './errors';
import { ADMIN_GROUP, USERS_GROUP } from './permissions';

const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface UsersPluginResult {
    /** Mount prefix (`/api/v1/qcli`). */
    prefix: '/api/v1/qcli';
    router: Router;
    /** Resolves once built-in groups and the root user are seeded. Requests wait for it automatically. */
    ready: Promise<void>;
    authService: AuthService;
    directory: DirectoryService;
    userStore: ICliUserStore;
    sessionStore: ICliSessionStore;
    credentialStore: ICliCredentialStore;
    groupStore: ICliGroupStore;
    auditStore: ICliAuditStore;
    /**
     * Auth provider for the CLI server and the admin dashboard. Installed by
     * `mountPlugin(usersPlugin)` or `createCliServer({ auth: usersPlugin.serverAuth })`.
     */
    serverAuth: UsersServerAuth;
    /** Whether mounting this plugin protects every server route and socket. */
    protectServer: boolean;
    /** Express middleware for host routes: requires a users session. */
    requireAuth: () => RequestHandler;
    /** Express middleware for host routes: requires all the given permissions. */
    requirePermission: (...permissions: string[]) => RequestHandler;
    /** Stops the background session sweep. */
    dispose: () => void;
}

/**
 * Fluent builder for the users plugin (authentication, users, groups,
 * permissions, sessions and audit).
 *
 * @example
 * ```ts
 * import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';
 *
 * const usersPlugin = new CliUsersBuilder()
 *     .setDefaultAdminPassword('admin')
 *     .build((msg) => eventSocketManager.broadcastMessage(msg));
 *
 * mountPlugin(usersPlugin);
 * await usersPlugin.ready;
 * ```
 */
export class CliUsersBuilder {
    private options: UsersModuleOptions = {};

    /** Merge raw options (the same shape `buildUsersPlugin` accepts). */
    setOptions(options: UsersModuleOptions): this {
        this.options = { ...this.options, ...options };
        return this;
    }

    setDefaultAdminPassword(password: string): this {
        this.options.defaultAdminPassword = password;
        return this;
    }

    setUserStore(store: ICliUserStore): this {
        this.options.userStore = store;
        return this;
    }

    setSessionStore(store: ICliSessionStore): this {
        this.options.sessionStore = store;
        return this;
    }

    setCredentialStore(store: ICliCredentialStore): this {
        this.options.credentialStore = store;
        return this;
    }

    setAuditStore(store: ICliAuditStore): this {
        this.options.auditStore = store;
        return this;
    }

    setGroupStore(store: ICliGroupStore): this {
        this.options.groupStore = store;
        return this;
    }

    /** Delegate authentication to the host application. */
    setAuthAdapter(adapter: AuthAdapter): this {
        this.options.authAdapter = adapter;
        return this;
    }

    /** Idle session timeout in milliseconds (default 30 minutes). */
    setSessionTimeout(ms: number): this {
        this.options.sessionTimeoutMs = ms;
        return this;
    }

    /** Consecutive failed logins before lockout (default 5). */
    setMaxLoginAttempts(attempts: number): this {
        this.options.maxLoginAttempts = attempts;
        return this;
    }

    /** Lockout duration in milliseconds (default 5 minutes). */
    setLockoutDuration(ms: number): this {
        this.options.lockoutMs = ms;
        return this;
    }

    /** Minimum password length (default 8). */
    setMinPasswordLength(length: number): this {
        this.options.minPasswordLength = length;
        return this;
    }

    /** Absolute session lifetime in milliseconds (default 12 hours). */
    setMaxSessionLifetime(ms: number): this {
        this.options.maxSessionLifetimeMs = ms;
        return this;
    }

    /** Protect every CLI server route and socket when mounted (default true). */
    setProtectServer(protect: boolean): this {
        this.options.protectServer = protect;
        return this;
    }

    /** Origins allowed for adapter/cookie-mode state changes (CSRF); inherited from the server when unset. */
    setAllowedOrigins(origins: string[]): this {
        this.options.allowedOrigins = origins;
        return this;
    }

    /**
     * Trusted reverse-proxy hops (`true` = 1, `false`/0 = none) for the client IP
     * used by the per-IP limiter: the `X-Forwarded-For` entry at index `len - hops`.
     */
    setTrustProxy(trust: boolean | number): this {
        this.options.trustProxy = trust;
        return this;
    }

    /** Per-IP attempts on login / verify-password / self password change (default 20 per minute). */
    setIpRateLimit(max: number, windowMs = 60_000): this {
        this.options.ipRateLimit = max;
        this.options.ipRateLimitWindowMs = windowMs;
        return this;
    }

    /** Interval of the background expired-session sweep (default 5 minutes). */
    setCleanupInterval(ms: number): this {
        this.options.cleanupIntervalMs = ms;
        return this;
    }

    /**
     * Builds the plugin synchronously. Seeding runs in the background; await
     * `ready` to know when it is done (requests wait for it automatically).
     *
     * @param broadcastFn Broadcasts `session-kicked` events over the events socket.
     */
    build(broadcastFn?: UsersBroadcastFn): UsersPluginResult {
        const options = this.options;
        const externalAuth = !!options.authAdapter;

        const userStore = options.userStore ?? new InMemoryUserStore();
        const sessionStore = options.sessionStore ?? new InMemorySessionStore();
        const credentialStore = options.credentialStore ?? new InMemoryCredentialStore();
        const auditStore = options.auditStore ?? new InMemoryAuditStore();
        const groupStore = options.groupStore ?? new InMemoryGroupStore();

        const authService = new AuthService(userStore, sessionStore, credentialStore, auditStore, {
            groupStore,
            sessionTimeoutMs: options.sessionTimeoutMs,
            maxLoginAttempts: options.maxLoginAttempts,
            lockoutMs: options.lockoutMs,
            minPasswordLength: options.minPasswordLength,
            maxSessionLifetimeMs: options.maxSessionLifetimeMs,
            broadcast: broadcastFn,
        });
        const directory = new DirectoryService(userStore, groupStore, authService);

        const ready = seed(userStore, groupStore, authService, externalAuth, options.defaultAdminPassword);
        ready.catch((err) => console.error('[users] seeding failed:', err));

        const waitReady = (_req: Request, _res: Response, next: NextFunction) => {
            ready.then(() => next(), next);
        };

        let allowedOrigins = options.allowedOrigins;
        const authenticator = new RequestAuthenticator(authService, options.authAdapter, () => allowedOrigins);
        const authMiddleware = createAuthMiddleware(authenticator);

        const trustProxy = options.trustProxy ?? false;
        const ipLimiter = new RateLimiter(options.ipRateLimit ?? 20, options.ipRateLimitWindowMs ?? 60_000);
        const limitAttempt = (req: Request) => {
            if (!ipLimiter.tryAcquire(clientIp(req, trustProxy))) {
                throw new HttpError(429, 'too many attempts, try again later');
            }
        };

        const protectServer = options.protectServer ?? true;
        const serverAuth = new UsersServerAuth(authService, authenticator, protectServer, (server) => {
            if (!allowedOrigins && server.allowedOrigins) {
                allowedOrigins = server.allowedOrigins;
            }
            if (!authService.hasBroadcast()) {
                authService.setBroadcast(server.broadcast);
            }
        });

        const router = Router();
        const scoped = ['/sessions', '/users', '/groups', '/audit'];
        router.use(scoped, json({ limit: '1mb' }), waitReady);
        router.use('/sessions', createSessionsController(authService, userStore, directory, authMiddleware, { externalAuth, limitAttempt }));
        router.use('/users', authMiddleware, createUsersController(authService, directory, { externalAuth, limitAttempt }));
        router.use('/groups', authMiddleware, createGroupsController(directory));
        router.use('/audit', authMiddleware, createAuditController(auditStore, authService));
        router.use(scoped, errorHandler);

        const cleanupInterval = setInterval(() => {
            ipLimiter.sweep();
            authService.cleanupExpiredSessions().catch((err) => console.error('[users] session cleanup failed:', err));
        }, options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
        cleanupInterval.unref?.();

        return {
            prefix: '/api/v1/qcli',
            router,
            ready,
            authService,
            directory,
            userStore,
            sessionStore,
            credentialStore,
            groupStore,
            auditStore,
            serverAuth,
            protectServer,
            requireAuth: () => serverAuth.requireAuth(),
            requirePermission: (...permissions: string[]) => serverAuth.requirePermission(...permissions),
            dispose: () => clearInterval(cleanupInterval),
        };
    }
}

const WEAK_PASSWORDS = new Set(['root', 'admin', 'password']);
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A random 16-character password. */
export function generatePassword(length = 16): string {
    let out = '';
    for (let i = 0; i < length; i++) {
        out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    }
    return out;
}

async function seed(
    userStore: ICliUserStore,
    groupStore: ICliGroupStore,
    authService: AuthService,
    externalAuth: boolean,
    configuredPassword: string | undefined,
): Promise<void> {
    if (!(await groupStore.getGroup(ADMIN_GROUP))) {
        await groupStore.createGroup({
            name: ADMIN_GROUP,
            description: 'Administrators (all permissions)',
            permissions: ['*'],
            builtIn: true,
        });
    }
    if (!(await groupStore.getGroup(USERS_GROUP))) {
        await groupStore.createGroup({
            name: USERS_GROUP,
            description: 'Default group for new accounts',
            permissions: ['commands:execute'],
            builtIn: true,
        });
    }

    if (externalAuth) {
        return;
    }
    const existing = await userStore.getUsers();
    if (existing.length === 0) {
        const generated = configuredPassword === undefined;
        const password = configuredPassword ?? generatePassword();
        const root = await userStore.createUser({
            name: 'root',
            email: 'root@localhost',
            groups: [ADMIN_GROUP],
            mustChangePassword: generated,
        });
        await authService.setPassword(root.id, password);
        if (generated) {
            console.warn(
                '[users] WARNING: no defaultAdminPassword configured. Generated password for user "root": ' +
                    `${password} — it must be changed at first login.`,
            );
        } else if (WEAK_PASSWORDS.has(password.toLowerCase())) {
            console.warn(`[users] WARNING: the "root" user uses a well-known default password. Change it before exposing this server.`);
        }
    }
}
