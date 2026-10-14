import { Router } from 'express';
import { UsersModuleOptions } from './models';
import { ICliUserStore, ICliSessionStore, ICliCredentialStore, ICliAuditStore, ICliGroupStore } from './stores/interfaces';
import { InMemoryUserStore } from './stores/in-memory-user-store';
import { InMemorySessionStore } from './stores/in-memory-session-store';
import { InMemoryCredentialStore } from './stores/in-memory-credential-store';
import { InMemoryAuditStore } from './stores/in-memory-audit-store';
import { InMemoryGroupStore } from './stores/in-memory-group-store';
import { AuthService } from './services/auth-service';
import { createAuthMiddleware } from './middleware/auth-middleware';
import { createUsersController } from './controllers/users-controller';
import { createSessionsController } from './controllers/sessions-controller';
import { createGroupsController } from './controllers/groups-controller';
import { createAuditController } from './controllers/audit-controller';

export { UsersModuleOptions } from './models';
export type { AuthAdapter } from './models';
export type { ICliUserStore, ICliSessionStore, ICliCredentialStore, ICliAuditStore, ICliGroupStore } from './stores/interfaces';
export { InMemoryUserStore } from './stores/in-memory-user-store';
export { InMemorySessionStore } from './stores/in-memory-session-store';
export { InMemoryCredentialStore } from './stores/in-memory-credential-store';
export { InMemoryAuditStore } from './stores/in-memory-audit-store';
export { InMemoryGroupStore } from './stores/in-memory-group-store';
export { AuthService } from './services/auth-service';

export interface UsersPluginResult {
    prefix: string;
    router: Router;
    authService: AuthService;
    userStore: ICliUserStore;
    sessionStore: ICliSessionStore;
    groupStore: ICliGroupStore;
    auditStore: ICliAuditStore;
    dispose: () => void;
}

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function buildUsersPlugin(
    options: UsersModuleOptions = {},
    broadcastEvent?: (msg: Record<string, unknown>) => void,
): Promise<UsersPluginResult> {
    const useExternalAuth = !!options.authAdapter;

    // 1. Create store instances (in-memory defaults, overridable via options)
    const userStore: ICliUserStore = options.userStore ?? new InMemoryUserStore();
    const sessionStore: ICliSessionStore = options.sessionStore ?? new InMemorySessionStore();
    const credentialStore: ICliCredentialStore =
        useExternalAuth
            ? options.credentialStore ?? new InMemoryCredentialStore() // still created but unused
            : options.credentialStore ?? new InMemoryCredentialStore();
    const auditStore: ICliAuditStore = options.auditStore ?? new InMemoryAuditStore();
    const groupStore: ICliGroupStore = options.groupStore || new InMemoryGroupStore();

    // 2. Create AuthService
    const authService = new AuthService(userStore, sessionStore, credentialStore, auditStore);

    // 3. Seed default admin user if no users exist (skip when using external auth)
    if (!useExternalAuth) {
        const existingUsers = await userStore.getUsers();
        if (existingUsers.length === 0) {
            const adminPassword = options.defaultAdminPassword ?? 'root';
            const adminUser = await userStore.createUser({
                name: 'root',
                email: 'root@localhost',
                groups: ['admin'],
            });
            await authService.setPassword(adminUser.id, adminPassword);
        }
    }

    // 4. Seed 'admin' group if not already present
    const existingAdminGroup = await groupStore.getGroup('admin');
    if (!existingAdminGroup) {
        await groupStore.createGroup('admin', 'Administrator group');
    }

    // 5. Create auth middleware (with optional adapter)
    const authMiddleware = createAuthMiddleware(sessionStore, options.authAdapter);

    // 6. Build the router
    const router = Router();

    // /sessions — login (POST /sessions) is public; the controller applies auth to the rest
    router.use('/sessions', createSessionsController(sessionStore, authService, authMiddleware, {
        externalAuth: useExternalAuth,
        broadcastEvent,
    }));

    // /users, /groups, /audit — auth required globally
    router.use('/users', authMiddleware, createUsersController(userStore, authService, credentialStore, sessionStore, {
        externalAuth: useExternalAuth,
    }));
    router.use('/groups', authMiddleware, createGroupsController(groupStore, userStore));
    router.use('/audit', authMiddleware, createAuditController(auditStore));

    // 7. Start cleanup interval
    const sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    const cleanupInterval = setInterval(async () => {
        await sessionStore.cleanup(sessionTimeoutMs);
    }, CLEANUP_INTERVAL_MS);

    // 8. Return plugin result
    return {
        prefix: '/api/v1/qcli',
        router,
        authService,
        userStore,
        sessionStore,
        groupStore,
        auditStore,
        dispose: () => clearInterval(cleanupInterval),
    };
}
