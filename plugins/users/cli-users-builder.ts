import { Router, json, Request, Response, NextFunction, RequestHandler } from 'express';
import type { ICliEventBus } from '@qodalis/cli-server-abstractions';
import { CliAuditBuilder, CliAuditGuard, CliAuditPluginResult, ICliAuditStore } from '@qodalis/cli-server-plugin-audit';
import { AuthAdapter, UsersBroadcastFn, UsersModuleOptions } from './models';
import {
    ICliUserStore,
    ICliSessionStore,
    ICliCredentialStore,
    ICliGroupStore,
    ICliApiTokenStore,
} from './stores/interfaces';
import { InMemoryUserStore } from './stores/in-memory-user-store';
import { InMemorySessionStore } from './stores/in-memory-session-store';
import { InMemoryCredentialStore } from './stores/in-memory-credential-store';
import { InMemoryGroupStore } from './stores/in-memory-group-store';
import { InMemoryApiTokenStore } from './stores/in-memory-api-token-store';
import { AuthService } from './services/auth-service';
import { DirectoryService } from './services/directory-service';
import { createAuthMiddleware, getAuth, requirePermission, RequestAuthenticator } from './middleware/auth-middleware';
import { createReadOnlyStoresGuard } from './middleware/read-only-stores';
import { UsersServerAuth } from './server-auth';
import { RateLimiter, clientIp } from './security';
import { randomInt } from 'crypto';
import { createUsersController } from './controllers/users-controller';
import { createSessionsController } from './controllers/sessions-controller';
import { createGroupsController } from './controllers/groups-controller';
import { createTokensController } from './controllers/tokens-controller';
import { createLinkController, LINK_CREATE_RATE_LIMIT } from './controllers/link-controller';
import { DEFAULT_LINK_APPROVAL_URL, LinkService } from './services/link-service';
import { errorHandler, HttpError } from './errors';
import { ADMIN_GROUP, USERS_GROUP } from './permissions';
import { CliInstalledPlugin, usersInstalledPlugin } from './package-info';

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
    /** Where the audit log is kept (`auditPlugin.store`). */
    auditStore: ICliAuditStore;
    /**
     * The audit plugin the users plugin records its events in. Its API is served by this
     * plugin's router at `/audit`, protected by the users sign-in.
     */
    auditPlugin: CliAuditPluginResult;
    /** Packages listed among the server's installed plugins with this one (the audit plugin). */
    installedPlugins: CliInstalledPlugin[];
    apiTokenStore: ICliApiTokenStore;
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
    /** This package, listed among the server's installed plugins by `mountPlugin`. */
    installedPlugin: CliInstalledPlugin;
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
 *     .build(eventBus); // or build() and mountPlugin(usersPlugin), which hands it the server's bus
 *
 * mountPlugin(usersPlugin);
 * await usersPlugin.ready;
 * ```
 */
export class CliUsersBuilder {
    private options: UsersModuleOptions = {};

    /** Merge raw options (`UsersModuleOptions`). */
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

    /**
     * The page where users approve a terminal's link request (`server add` in the web CLI):
     * absolute or root-relative, `{code}` replaced by the code (otherwise `?code=` is appended).
     * Defaults to the admin dashboard's `/qcli/admin/link`.
     */
    setLinkApprovalUrl(url: string): this {
        if (!/^(https?:\/\/[^\s]+|\/(?![\/\\])[^\s]*)$/.test(url)) {
            throw new Error('[users] linkApprovalUrl must be an http(s) URL or a root-relative path');
        }
        this.options.linkApprovalUrl = url;
        return this;
    }

    /** Keeps the audit log in `store`: the same as setting the store of the audit plugin this plugin adds. */
    setAuditStore(store: ICliAuditStore): this {
        this.options.auditStore = store;
        return this;
    }

    /**
     * Records events in, and serves, the host's own audit plugin (`new CliAuditBuilder()...build()`)
     * instead of one the users plugin builds. Use it when the host builds the audit plugin itself.
     */
    setAuditPlugin(plugin: CliAuditPluginResult): this {
        this.options.auditPlugin = plugin;
        return this;
    }

    setGroupStore(store: ICliGroupStore): this {
        this.options.groupStore = store;
        return this;
    }

    /** API token storage (default in-memory). */
    setApiTokenStore(store: ICliApiTokenStore): this {
        this.options.apiTokenStore = store;
        return this;
    }

    /** Allow API tokens that never expire (`expiresInDays: null`; default false). */
    setAllowNonExpiringTokens(allow: boolean): this {
        this.options.allowNonExpiringTokens = allow;
        return this;
    }

    /**
     * Delegate authentication to the host application. The adapter may be sync
     * or async (return a Promise); the plugin awaits it for requests, ticket
     * issuance and the re-checks of open sockets.
     */
    setAuthAdapter(adapter: AuthAdapter): this {
        this.options.authAdapter = adapter;
        return this;
    }

    /**
     * The host application owns the users (e.g. a user store over its own accounts):
     * user writes (create, update, delete, password set) and group membership changes
     * answer 501 `Users are managed by the host application` without calling any store,
     * no `root` user is seeded, and session payloads report `usersReadOnly: true`.
     */
    setReadOnlyUsers(readOnly = true): this {
        this.options.readOnlyUsers = readOnly;
        return this;
    }

    /**
     * The host application owns the groups: group create, update and delete answer
     * 501 `Groups are managed by the host application` without calling the store, the
     * built-in groups are not seeded, and session payloads report `groupsReadOnly: true`.
     */
    setReadOnlyGroups(readOnly = true): this {
        this.options.readOnlyGroups = readOnly;
        return this;
    }

    /** Idle session timeout in milliseconds (default 30 minutes). */
    setSessionTimeout(ms: number): this {
        this.options.sessionTimeoutMs = ms;
        return this;
    }

    /**
     * Consecutive failed logins before lockout (default 5). A failure count whose
     * latest attempt is older than the lockout duration expires (resets).
     */
    setMaxLoginAttempts(attempts: number): this {
        this.options.maxLoginAttempts = attempts;
        return this;
    }

    /** Lockout duration in milliseconds (default 5 minutes); also the window failures are counted in. */
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
     * @param events The server's event bus (`createCliServer().eventBus`), or a function
     *   broadcasting raw messages over the events socket (kept for compatibility). The
     *   plugin publishes `user:*`, `group:*`, `token:*` and `session:*` events and the
     *   `session-kicked` control message. Mounting the plugin hands it the server's bus
     *   when it was not given one.
     */
    build(events?: ICliEventBus | UsersBroadcastFn): UsersPluginResult {
        const broadcastFn = typeof events === 'function' ? events : undefined;
        const eventBus = events && typeof events === 'object' ? events : undefined;
        const options = this.options;
        const externalAuth = !!options.authAdapter;
        const usersReadOnly = options.readOnlyUsers ?? false;
        const groupsReadOnly = options.readOnlyGroups ?? false;

        const userStore = options.userStore ?? new InMemoryUserStore();
        const sessionStore = options.sessionStore ?? new InMemorySessionStore();
        const credentialStore = options.credentialStore ?? new InMemoryCredentialStore();
        // The audit log is the audit plugin's: the users plugin records its events there and serves its API.
        if (options.auditPlugin && options.auditStore && options.auditPlugin.store !== options.auditStore) {
            throw new Error('[users] auditStore and auditPlugin disagree: set the store on the audit plugin');
        }
        const auditPlugin = options.auditPlugin ?? buildAuditPlugin(options.auditStore);
        const auditStore = auditPlugin.store;
        const groupStore = options.groupStore ?? new InMemoryGroupStore();
        const apiTokenStore = options.apiTokenStore ?? new InMemoryApiTokenStore();

        const authService = new AuthService(userStore, sessionStore, credentialStore, auditStore, {
            groupStore,
            sessionTimeoutMs: options.sessionTimeoutMs,
            maxLoginAttempts: options.maxLoginAttempts,
            lockoutMs: options.lockoutMs,
            minPasswordLength: options.minPasswordLength,
            maxSessionLifetimeMs: options.maxSessionLifetimeMs,
            broadcast: broadcastFn,
            eventBus,
            apiTokenStore,
            allowNonExpiringTokens: options.allowNonExpiringTokens,
            usersReadOnly,
            groupsReadOnly,
        });
        const directory = new DirectoryService(userStore, groupStore, authService);
        if (eventBus) {
            auditPlugin.setEventBus?.(eventBus);
        }

        const ready = seed(userStore, groupStore, authService, {
            externalAuth,
            usersReadOnly,
            groupsReadOnly,
            configuredPassword: options.defaultAdminPassword,
        });
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
            if (!authService.hasEventBus() && server.eventBus) {
                authService.setEventBus(server.eventBus);
            }
            // The audit plugin it serves publishes audit:recorded on the same bus
            if (!eventBus && server.eventBus) {
                auditPlugin.setEventBus?.(server.eventBus);
            }
            // The host application signs users in (admin dashboard: GET /api/v1/qcli/auth/mode).
            if (server.serverOptions) {
                server.serverOptions.externalAuthentication = externalAuth;
            }
        });

        const router = Router();
        // Writes to read-only stores answer 501 before body parsing and authentication.
        const readOnly = { usersReadOnly, groupsReadOnly, externalAuth };
        router.use('/users', createReadOnlyStoresGuard('users', readOnly));
        router.use('/groups', createReadOnlyStoresGuard('groups', readOnly));
        const scoped = ['/sessions', '/users', '/groups', '/audit', '/tokens', '/link'];
        router.use(scoped, json({ limit: '1mb' }), waitReady);
        router.use('/sessions', createSessionsController(authService, userStore, directory, authMiddleware, { externalAuth, limitAttempt }));
        router.use('/users', authMiddleware, createUsersController(authService, directory, { externalAuth, limitAttempt }));
        router.use('/groups', authMiddleware, createGroupsController(directory));
        // The audit API is protected by the users sign-in and permissions (and by the
        // server's route policy on a protected server).
        const auditGuard: CliAuditGuard = (permission) => [
            authMiddleware,
            requirePermission(permission),
            (req, _res, next) => {
                const request = req as Request & { qcliServerAuth?: unknown };
                request.qcliServerAuth ??= UsersServerAuth.toServerContext(getAuth(req));
                next();
            },
        ];
        auditPlugin.protect(auditGuard);
        router.use('/audit', auditPlugin.router);
        router.use('/tokens', authMiddleware, createTokensController(authService, userStore));
        const linkService = new LinkService(authService, options.linkApprovalUrl ?? DEFAULT_LINK_APPROVAL_URL);
        const linkLimiter = new RateLimiter(LINK_CREATE_RATE_LIMIT, 60_000);
        router.use('/link', createLinkController(linkService, authMiddleware, { trustProxy, limiter: linkLimiter }));
        router.use(scoped, errorHandler);

        const cleanupInterval = setInterval(() => {
            ipLimiter.sweep();
            linkService.sweep();
            linkLimiter.sweep();
            authService.sweepLockouts();
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
            auditPlugin,
            apiTokenStore,
            serverAuth,
            protectServer,
            requireAuth: () => serverAuth.requireAuth(),
            requirePermission: (...permissions: string[]) => serverAuth.requirePermission(...permissions),
            dispose: () => clearInterval(cleanupInterval),
            installedPlugin: usersInstalledPlugin,
            installedPlugins: [auditPlugin.installedPlugin],
        };
    }
}

function buildAuditPlugin(store: ICliAuditStore | undefined): CliAuditPluginResult {
    const builder = new CliAuditBuilder();
    if (store) builder.setStore(store);
    return builder.build();
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
    options: { externalAuth: boolean; usersReadOnly: boolean; groupsReadOnly: boolean; configuredPassword: string | undefined },
): Promise<void> {
    const { configuredPassword } = options;
    // Read-only stores belong to the host application: nothing is seeded into them.
    if (!options.groupsReadOnly) {
        await seedBuiltInGroups(groupStore);
    }
    if (options.externalAuth || options.usersReadOnly) {
        return;
    }
    await seedRoot(userStore, authService, configuredPassword);
}

async function seedBuiltInGroups(groupStore: ICliGroupStore): Promise<void> {
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
}

async function seedRoot(userStore: ICliUserStore, authService: AuthService, configuredPassword: string | undefined): Promise<void> {
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
            // Written straight to stderr, never through `console`: console output can be
            // captured (the admin plugin's log buffer) and broadcast to log/event sockets.
            process.stderr.write(
                '[users] WARNING: no defaultAdminPassword configured. Generated password for user "root": ' +
                    `${password} — it must be changed at first login.\n`,
            );
        } else if (WEAK_PASSWORDS.has(password.toLowerCase())) {
            console.warn(`[users] WARNING: the "root" user uses a well-known default password. Change it before exposing this server.`);
        }
    }
}
