import { Router, json, Request, Response, NextFunction } from 'express';
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
import { createAuthMiddleware } from './middleware/auth-middleware';
import { createUsersController } from './controllers/users-controller';
import { createSessionsController } from './controllers/sessions-controller';
import { createGroupsController } from './controllers/groups-controller';
import { createAuditController } from './controllers/audit-controller';
import { errorHandler } from './errors';
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

    /** Minimum password length (default 4). */
    setMinPasswordLength(length: number): this {
        this.options.minPasswordLength = length;
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
            broadcast: broadcastFn,
        });
        const directory = new DirectoryService(userStore, groupStore, authService);

        const ready = seed(userStore, groupStore, authService, externalAuth, options.defaultAdminPassword ?? 'root');
        ready.catch((err) => console.error('[users] seeding failed:', err));

        const waitReady = (_req: Request, _res: Response, next: NextFunction) => {
            ready.then(() => next(), next);
        };

        const authMiddleware = createAuthMiddleware(authService, options.authAdapter);

        const router = Router();
        const scoped = ['/sessions', '/users', '/groups', '/audit'];
        router.use(scoped, json(), waitReady);
        router.use('/sessions', createSessionsController(authService, userStore, authMiddleware, { externalAuth }));
        router.use('/users', authMiddleware, createUsersController(authService, directory, { externalAuth }));
        router.use('/groups', authMiddleware, createGroupsController(directory));
        router.use('/audit', authMiddleware, createAuditController(auditStore, authService));
        router.use(scoped, errorHandler);

        const cleanupInterval = setInterval(() => {
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
            dispose: () => clearInterval(cleanupInterval),
        };
    }
}

async function seed(
    userStore: ICliUserStore,
    groupStore: ICliGroupStore,
    authService: AuthService,
    externalAuth: boolean,
    adminPassword: string,
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
            permissions: [],
            builtIn: true,
        });
    }

    if (externalAuth) {
        return;
    }
    const existing = await userStore.getUsers();
    if (existing.length === 0) {
        const root = await userStore.createUser({ name: 'root', email: 'root@localhost', groups: [ADMIN_GROUP] });
        await authService.setPassword(root.id, adminPassword);
    }
}
