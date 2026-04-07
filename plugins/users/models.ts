export interface User {
    id: string;
    name: string;
    email: string;
    groups: string[];
    disabled?: boolean;
    data?: Record<string, any>;
    lastLoginAt?: number;
    createdAt: number;
    updatedAt: number;
}

export interface CreateUserDto {
    name: string;
    email: string;
    password?: string;
    groups?: string[];
    data?: Record<string, any>;
}

export interface UpdateUserDto {
    name?: string;
    email?: string;
    groups?: string[];
    disabled?: boolean;
    data?: Record<string, any>;
}

export interface Credentials {
    userId: string;
    passwordHash: string;
    salt: string;
    lastChanged: number;
}

export interface Session {
    id: string;
    token: string;
    userId: string;
    user: User;
    loginTime: number;
    lastActivity: number;
    metadata: SessionMetadata;
}

export interface SessionMetadata {
    remoteAddress?: string;
    userAgent?: string;
}

export interface AuditEntry {
    timestamp: number;
    event: string;
    username: string;
    details?: string;
    metadata?: {
        remoteAddress?: string;
        sessionId?: string;
    };
}

export interface AuditQueryOptions {
    limit?: number;
    event?: string;
    username?: string;
}

export interface Group {
    id: string;
    name: string;
    description?: string;
    createdAt: number;
}

export type AuthAdapter = (req: import('express').Request) => { user: User; isAdmin: boolean } | undefined | null;

export interface UsersModuleOptions {
    userStore?: import('./stores/interfaces').ICliUserStore;
    sessionStore?: import('./stores/interfaces').ICliSessionStore;
    credentialStore?: import('./stores/interfaces').ICliCredentialStore;
    auditStore?: import('./stores/interfaces').ICliAuditStore;
    groupStore?: import('./stores/interfaces').ICliGroupStore;
    sessionTimeoutMs?: number;
    defaultAdminPassword?: string;
    /**
     * When provided, the plugin delegates authentication to the host application.
     * The adapter receives the Express request (after the host's own auth middleware
     * has run) and returns the CLI user + admin flag, or null/undefined if the
     * request is unauthenticated.
     *
     * When set, the built-in login/logout/verify endpoints return 501 and the
     * plugin skips seeding a root user and credential store.
     */
    authAdapter?: AuthAdapter;
}
