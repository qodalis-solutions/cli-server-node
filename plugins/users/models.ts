import type { Request } from 'express';
import type {
    ICliUserStore,
    ICliSessionStore,
    ICliCredentialStore,
    ICliAuditStore,
    ICliGroupStore,
} from './stores/interfaces';

/** A CLI user. All timestamps are epoch milliseconds. */
export interface User {
    id: string;
    name: string;
    email: string;
    /** Group names the user belongs to. */
    groups: string[];
    /** Always present in API responses (false by default). */
    disabled?: boolean;
    homeDir?: string;
    data?: Record<string, any>;
    lastLoginAt?: number;
    createdAt: number;
    updatedAt: number;
}

export interface CreateUserDto {
    name: string;
    email: string;
    /** @deprecated Passwords are set through the auth service, never stored on the user. */
    password?: string;
    groups?: string[];
    disabled?: boolean;
    homeDir?: string;
    data?: Record<string, any>;
}

export interface UpdateUserDto {
    name?: string;
    email?: string;
    groups?: string[];
    disabled?: boolean;
    homeDir?: string;
    data?: Record<string, any>;
    lastLoginAt?: number;
}

export interface Credentials {
    userId: string;
    /** Encoded hash: `pbkdf2$<iterations>$<saltB64>$<hashB64>`. */
    passwordHash: string;
    /** Salt (base64). Also embedded in `passwordHash`; kept for store compatibility. */
    salt: string;
    lastChanged: number;
}

/** A stored session. The user is referenced by id and resolved live on every request. */
export interface Session {
    id: string;
    token: string;
    userId: string;
    createdAt: number;
    lastActivity: number;
    metadata: SessionMetadata;
}

export interface SessionMetadata {
    remoteAddress?: string;
    userAgent?: string;
}

/** Session as exposed by `GET /sessions` — never includes the token. */
export interface SessionView {
    id: string;
    userId: string;
    userName: string;
    createdAt: number;
    lastActivity: number;
    expiresAt: number;
    metadata: SessionMetadata;
    current?: boolean;
}

/** Session payload returned by login and `GET /sessions/current`. */
export interface SessionPayload {
    id: string;
    user: User;
    permissions: string[];
    loginTime: number;
    lastActivity: number;
    expiresAt: number;
}

export interface LoginResult {
    token: string;
    session: SessionPayload;
}

export interface AuditEntry {
    id?: string;
    timestamp: number;
    event: string;
    /** The user the event is about. */
    username: string;
    details?: string;
    /** The acting user, when different from / in addition to `username`. */
    actor?: string;
    metadata?: {
        remoteAddress?: string;
        sessionId?: string;
        [key: string]: unknown;
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
    permissions: string[];
    builtIn: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface CreateGroupDto {
    name: string;
    description?: string;
    permissions?: string[];
    builtIn?: boolean;
}

export interface UpdateGroupDto {
    description?: string;
    permissions?: string[];
}

/**
 * Resolves the CLI user from a request already authenticated by the host app.
 * Return `null`/`undefined` when the request is unauthenticated.
 * `isAdmin: true` adds the user to the `admin` group for this request.
 */
export type AuthAdapter = (req: Request) => { user: User; isAdmin: boolean } | undefined | null;

/** Broadcasts an event over the server's events socket. */
export type UsersBroadcastFn = (msg: Record<string, unknown>) => void;

export interface UsersModuleOptions {
    userStore?: ICliUserStore;
    sessionStore?: ICliSessionStore;
    credentialStore?: ICliCredentialStore;
    auditStore?: ICliAuditStore;
    groupStore?: ICliGroupStore;
    /** Idle timeout in ms (default 30 minutes). */
    sessionTimeoutMs?: number;
    /** Password of the seeded `root` user (default `root`). */
    defaultAdminPassword?: string;
    /** Consecutive failures before lockout (default 5). */
    maxLoginAttempts?: number;
    /** Lockout duration in ms (default 5 minutes). */
    lockoutMs?: number;
    /** Minimum password length (default 4). */
    minPasswordLength?: number;
    /** Interval of the background expired-session sweep in ms (default 5 minutes). */
    cleanupIntervalMs?: number;
    /**
     * Delegate authentication to the host application. Login, logout,
     * verify-password and password endpoints then return 501, no `root` user
     * is seeded, and adapter sessions are neither stored nor listed.
     */
    authAdapter?: AuthAdapter;
}
