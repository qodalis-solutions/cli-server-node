import type { Request } from 'express';
import type { CliAuditPluginResult, ICliAuditStore } from '@qodalis/cli-server-plugin-audit';
import type {
    ICliUserStore,
    ICliSessionStore,
    ICliCredentialStore,
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
    /**
     * Users are managed by the host application (`readOnlyUsers`): user writes
     * answer 501, so clients hide `adduser`, `usermod`, `userdel`, `passwd`, ...
     */
    usersReadOnly: boolean;
    /**
     * Groups are managed by the host application (`readOnlyGroups`): group writes
     * answer 501, so clients hide `groupadd`, `groupmod`, `groupdel`.
     */
    groupsReadOnly: boolean;
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

/** The audit log contract lives in `@qodalis/cli-server-abstractions` (re-exported by the audit plugin). */
export type { AuditEntry, AuditQueryOptions } from '@qodalis/cli-server-plugin-audit';

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

/** What an {@link AuthAdapter} returns for an authenticated request. */
export interface ExternalAuthResult {
    user: User;
    /** Adds the user to the `admin` group for this request. */
    isAdmin?: boolean;
    /**
     * Permissions granted directly by the host (e.g. `logs:read`, `commands:execute`),
     * added to those of the user's groups (and of `admin` with `isAdmin`). Lets hosts
     * with their own roles grant permissions without a group per permission; group
     * names missing from the group store grant nothing.
     */
    permissions?: string[];
}

/**
 * Resolves the CLI user from a request already authenticated by the host app.
 * Return `null`/`undefined` when the request is unauthenticated. May be async
 * (return a Promise), e.g. to load the user, their roles or their disabled
 * state from a database: the plugin always awaits the result.
 */
export type AuthAdapter = (
    req: Request,
) => ExternalAuthResult | undefined | null | Promise<ExternalAuthResult | undefined | null>;

/** Broadcasts an event over the server's events socket. */
export type UsersBroadcastFn = (msg: Record<string, unknown>) => void;

export interface UsersModuleOptions {
    userStore?: ICliUserStore;
    sessionStore?: ICliSessionStore;
    credentialStore?: ICliCredentialStore;
    /** Where the audit log is kept: the same as setting the audit plugin's store. */
    auditStore?: ICliAuditStore;
    /**
     * The audit plugin to record events in and serve at `/audit` (default: one built
     * with `auditStore`, or in memory). Pass the host's own when it builds one.
     */
    auditPlugin?: CliAuditPluginResult;
    groupStore?: ICliGroupStore;
    /** API token storage (default in-memory). */
    apiTokenStore?: ICliApiTokenStore;
    /** Allow API tokens that never expire (`expiresInDays: null`; default false). */
    allowNonExpiringTokens?: boolean;
    /**
     * With an auth adapter (`authAdapter`), also accept the plugin's API tokens
     * (`qcli_pat_…` bearer tokens, checked before the adapter), so users signed in
     * by the host can create tokens (`POST /tokens`) and approve terminal links
     * (`POST /link/code/{code}/approve`, `server add` in the web CLI). Default false:
     * the host owns sign-in. The token's user is read from the user store by id on
     * every request and socket re-check, so the store must find the adapter's users
     * and report `disabled`; keep the tokens in a persistent `apiTokenStore` (the
     * default store forgets them on restart). Ignored without an adapter (tokens are
     * always on).
     */
    apiTokensWithExternalAuth?: boolean;
    /** The page where users approve a terminal's link request (default the dashboard's `/qcli/admin/link`). */
    linkApprovalUrl?: string;
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
    /**
     * The host application owns the users (e.g. a user store over its own
     * accounts): creating, updating (self too) and deleting users, password
     * changes and group membership changes answer 501 `Users are managed by the
     * host application` without calling any store, no `root` user is seeded, and
     * deleting a group leaves memberships alone. Default false.
     */
    readOnlyUsers?: boolean;
    /**
     * The host application owns the groups: creating, updating and deleting
     * groups answer 501 `Groups are managed by the host application` without
     * calling the store, and the built-in groups are not seeded. Default false.
     */
    readOnlyGroups?: boolean;
}
