import type { Request } from 'express';
import type {
    ICliUserStore,
    ICliSessionStore,
    ICliCredentialStore,
    ICliAuditStore,
    ICliGroupStore,
    ICliApiTokenStore,
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
    /** When true the user must change their password before doing anything else. Always present in API responses. */
    mustChangePassword?: boolean;
    homeDir?: string;
    data?: Record<string, any>;
    lastLoginAt?: number;
    createdAt: number;
    updatedAt: number;
}

export interface CreateUserDto {
    name: string;
    email: string;
    groups?: string[];
    disabled?: boolean;
    mustChangePassword?: boolean;
    homeDir?: string;
    data?: Record<string, any>;
}

export interface UpdateUserDto {
    name?: string;
    email?: string;
    groups?: string[];
    disabled?: boolean;
    mustChangePassword?: boolean;
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

/**
 * A stored session. The user is referenced by id and resolved live on every
 * request. Stores keep only `SHA-256(token)` (hex), never the raw token.
 */
export interface Session {
    id: string;
    tokenHash: string;
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

/**
 * A long-lived API token (`qcli_pat_…`). Stores keep only `SHA-256(token)`
 * (hex), never the token itself.
 */
export interface ApiToken {
    id: string;
    userId: string;
    /** 1-64 characters of `[A-Za-z0-9._ -]`, unique per user (case-insensitive). */
    name: string;
    tokenHash: string;
    createdAt: number;
    /** Null when the token never expires. */
    expiresAt: number | null;
    /** Updated at most once per 60 seconds. */
    lastUsedAt?: number;
    /** Optional scope; absent when the token carries the user's full permissions. */
    permissions?: string[];
}

/** API token as exposed by `GET /tokens` — never includes the token or its hash. */
export interface ApiTokenView {
    id: string;
    name: string;
    userId: string;
    userName: string;
    createdAt: number;
    expiresAt: number | null;
    lastUsedAt: number | null;
    permissions?: string[];
}

/** Result of `POST /tokens`: the token (shown once) and its view. */
export interface CreateApiTokenResult {
    token: string;
    apiToken: ApiTokenView;
}

export interface AuditEntry {
    id?: string;
    timestamp: number;
    event: string;
    /** The user the event is about. */
    username: string;
    details?: string;
    /** Id of the user the event is about, when known. */
    userId?: string;
    /** The acting user, when different from / in addition to `username`. */
    actor?: string;
    /** Id of the acting user, when known. */
    actorId?: string;
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
    /** API token storage (default in-memory). */
    apiTokenStore?: ICliApiTokenStore;
    /** Allow API tokens that never expire (`expiresInDays: null`; default false). */
    allowNonExpiringTokens?: boolean;
    /** Idle timeout in ms (default 30 minutes). */
    sessionTimeoutMs?: number;
    /** Password of the seeded `root` user (default `root`). */
    defaultAdminPassword?: string;
    /** Consecutive failures before lockout (default 5); a count older than `lockoutMs` resets. */
    maxLoginAttempts?: number;
    /** Lockout duration in ms (default 5 minutes); also the window failures are counted in. */
    lockoutMs?: number;
    /** Minimum password length (default 8; maximum length is always 1024). */
    minPasswordLength?: number;
    /** Absolute session lifetime in ms regardless of activity (default 12 hours). */
    maxSessionLifetimeMs?: number;
    /**
     * Protect every CLI server route and socket with users sessions (default true).
     * Takes effect when the plugin is mounted with `mountPlugin` or passed to
     * `createCliServer({ auth })`.
     */
    protectServer?: boolean;
    /** Origins allowed for CORS, WebSocket upgrades and cookie/adapter-mode state changes (CSRF). */
    allowedOrigins?: string[];
    /**
     * Trusted reverse-proxy hops for the client IP (`true` = 1, `false`/0 = none,
     * the default): the `X-Forwarded-For` entry at index `len - hops` (the
     * rightmost with one hop); the leftmost when the list is shorter.
     */
    trustProxy?: boolean | number;
    /** Per-IP attempts on login / verify-password / self password change per window (default 20). */
    ipRateLimit?: number;
    /** Per-IP limiter window in ms (default 60 seconds). */
    ipRateLimitWindowMs?: number;
    /** Interval of the background expired-session sweep in ms (default 5 minutes). */
    cleanupIntervalMs?: number;
    /**
     * Delegate authentication to the host application. Login, logout,
     * verify-password and password endpoints then return 501, no `root` user
     * is seeded, and adapter sessions are neither stored nor listed.
     */
    authAdapter?: AuthAdapter;
}
