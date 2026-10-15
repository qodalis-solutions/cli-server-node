import type { Request } from 'express';

/** Identity of an authenticated caller (HTTP request or WebSocket). */
export interface CliServerAuthContext {
    userId: string;
    userName: string;
    /** Absent for host-authenticated (adapter) callers. */
    sessionId?: string;
    /** Effective permissions (`resource:action`, `*` wildcards). */
    permissions: string[];
}

/** Error thrown by {@link ICliServerAuth.authenticateRequest}; rendered as `{ error }`. */
export interface CliServerAuthError extends Error {
    status?: number;
}

/**
 * Authentication provider that protects the whole CLI server (routes and
 * sockets). Implemented by the users plugin (`usersPlugin.serverAuth`).
 */
export interface ICliServerAuth {
    /** When false the server stays open; sockets only use tickets for optional identity. */
    readonly protectServer: boolean;
    /** True for routes the provider authenticates itself (its own API, its login). */
    handlesPath(path: string, method: string): boolean;
    /**
     * Authenticates an HTTP request. Throws an error with `status`
     * (401 unauthenticated, 403 e.g. password change required / CSRF); any
     * other error is logged and answered with a generic 500.
     */
    authenticateRequest(req: Request): Promise<CliServerAuthContext>;
    /**
     * Consumes a single-use WebSocket ticket; undefined when invalid/expired/used.
     * May throw an error with `status: 403` when the identity is valid but not
     * allowed yet (e.g. password change required).
     */
    consumeTicket(ticket: string): Promise<CliServerAuthContext | undefined>;
    hasPermission(ctx: CliServerAuthContext, permission: string): boolean;
    /** Called once when installed into a server. */
    attachToServer?(server: {
        allowedOrigins?: string[];
        broadcast: (message: Record<string, unknown>) => void;
    }): void;
    /**
     * Re-validates a socket identity without sliding the session: the session still
     * exists and is not expired, the user exists and is enabled. Returns the identity
     * with fresh permissions, or undefined when it ended. Used to bind long-lived
     * sockets (the shell) to their session.
     */
    revalidate?(ctx: CliServerAuthContext): Promise<CliServerAuthContext | undefined>;
    /** Records activity on the session behind `ctx` (slides the idle expiry). */
    touch?(ctx: CliServerAuthContext): Promise<void>;
    /** Writes an audit entry (never include secrets, command text or stdin). */
    audit?(entry: CliServerAuditEntry): Promise<void>;
    /** Subscribes to session lifecycle events; returns an unsubscribe function. */
    onSessionEvent?(listener: (event: CliServerSessionEvent) => void): () => void;
}

/** Audit entry written by the server through {@link ICliServerAuth.audit}. */
export interface CliServerAuditEntry {
    event: string;
    userId: string;
    userName: string;
    /** Acting user (defaults to the user). */
    actorId?: string;
    actorName?: string;
    details?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Session lifecycle events emitted by the auth provider:
 * - `session-ended`: logout, expiry, revoke (kick), user disabled/deleted;
 * - `access-changed`: users/groups/permissions changed (re-check permissions).
 */
export type CliServerSessionEvent =
    | { type: 'session-ended'; sessionId: string; userId?: string; reason?: string }
    | { type: 'access-changed'; userId?: string };

/** Server permissions enforced when the users plugin protects the server. */
export const CliServerPermissions = {
    CommandsExecute: 'commands:execute',
    FilesRead: 'files:read',
    FilesWrite: 'files:write',
    DataQuery: 'data:query',
    JobsRead: 'jobs:read',
    JobsManage: 'jobs:manage',
    LogsRead: 'logs:read',
    ShellExecute: 'shell:execute',
    AdminAccess: 'admin:access',
} as const;

/**
 * Exact origin match. An entry ending in `:*` matches any port of that
 * scheme+host (e.g. `http://127.0.0.1:*`).
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[] | undefined): boolean {
    if (!origin || !allowed || allowed.length === 0) return false;
    const o = origin.toLowerCase().replace(/\/+$/, '');
    return allowed.some((entry) => {
        const e = entry.toLowerCase().replace(/\/+$/, '');
        if (e.endsWith(':*')) {
            const base = e.slice(0, -2);
            return o === base || (o.startsWith(base + ':') && /^\d+$/.test(o.slice(base.length + 1)));
        }
        return o === e;
    });
}

/**
 * Number of trusted reverse-proxy hops for a `trustProxy` setting:
 * `false`/`0`/absent → 0 (untrusted), `true` → 1, a number n → n (values
 * below 1 other than 0 count as 1).
 */
export function trustedProxyHops(trustProxy: boolean | number | undefined): number {
    if (typeof trustProxy === 'number') {
        if (trustProxy === 0) return 0;
        return trustProxy >= 1 ? Math.floor(trustProxy) : 1;
    }
    return trustProxy ? 1 : 0;
}

/**
 * The `X-Forwarded-For` entry identifying the client behind `hops` trusted
 * proxies: index `len - hops` (with one hop, the rightmost entry, appended by
 * the trusted proxy; leftmost entries are client-controlled). The leftmost
 * entry when the list is shorter than `hops`; undefined when the header is
 * absent or the selected entry is empty.
 */
function forwardedClient(header: string | string[] | undefined, hops: number): string | undefined {
    if (hops <= 0 || header === undefined) return undefined;
    const entries = (Array.isArray(header) ? header.join(',') : header).split(',').map((e) => e.trim());
    return entries[Math.max(0, entries.length - hops)] || undefined;
}

/**
 * The client address: the socket address, or with `trustProxy` (a hop count,
 * `true` = 1) the `X-Forwarded-For` entry at index `len - hops`.
 */
export function clientAddress(
    req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } | null },
    trustProxy: boolean | number | undefined,
): string {
    return forwardedClient(req.headers['x-forwarded-for'], trustedProxyHops(trustProxy)) ?? req.socket?.remoteAddress ?? 'unknown';
}

/** Minimal request shape for {@link isSameOrigin} (Node `IncomingMessage` or Express `Request`). */
export interface OriginCheckRequest {
    headers: Record<string, string | string[] | undefined>;
    socket?: { encrypted?: boolean; remoteAddress?: string } | null;
    /** Express app (when present, its `trust proxy` setting is honoured). */
    app?: { get?: (name: string) => unknown };
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' };

function firstHeader(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    const first = raw?.split(',')[0]?.trim();
    return first || undefined;
}

/** `scheme://host:port`, lower-cased, explicit port (http:80, https:443); `ws`/`wss` map to `http`/`https`. */
function normalizeOrigin(scheme: string, hostPort: string): string | undefined {
    let s = scheme.toLowerCase().replace(/:$/, '');
    if (s === 'ws') s = 'http';
    if (s === 'wss') s = 'https';
    if (!DEFAULT_PORTS[s]) return undefined;
    try {
        const url = new URL(`${s}://${hostPort}`);
        if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) return undefined;
        return `${s}://${url.hostname.toLowerCase()}:${url.port || DEFAULT_PORTS[s]}`;
    } catch {
        return undefined;
    }
}

function proxyTrusted(req: OriginCheckRequest, trustProxy: boolean | number | undefined): boolean {
    if (trustProxy !== undefined) return trustedProxyHops(trustProxy) > 0;
    const fn = req.app?.get?.('trust proxy fn');
    return typeof fn === 'function' ? Boolean((fn as (addr: string | undefined, i: number) => unknown)(req.socket?.remoteAddress, 0)) : false;
}

/**
 * The request's own origin (`scheme://host:port`, normalized): the scheme from
 * the socket (TLS or not) and the `Host` header. Behind a trusted proxy
 * (`trustProxy`, or the Express app's `trust proxy` setting when omitted)
 * `X-Forwarded-Proto` / `X-Forwarded-Host` win.
 */
export function requestOrigin(req: OriginCheckRequest, trustProxy?: boolean | number): string | undefined {
    const trusted = proxyTrusted(req, trustProxy);
    const scheme = (trusted && firstHeader(req.headers['x-forwarded-proto'])) || (req.socket?.encrypted ? 'https' : 'http');
    const host = (trusted && firstHeader(req.headers['x-forwarded-host'])) || firstHeader(req.headers['host']);
    return host ? normalizeOrigin(scheme, host) : undefined;
}

/**
 * True when `origin` is the request's own origin (e.g. the bundled admin
 * dashboard served by this server). Same-origin requests are not cross-site
 * and always pass Origin/CSRF checks. Case-insensitive; default ports normalized.
 */
export function isSameOrigin(origin: string | undefined, req: OriginCheckRequest, trustProxy?: boolean | number): boolean {
    if (!origin || origin === 'null') return false;
    let o: string | undefined;
    try {
        const url = new URL(origin);
        o = normalizeOrigin(url.protocol, url.host);
    } catch {
        return false;
    }
    const own = requestOrigin(req, trustProxy);
    return !!o && !!own && o === own;
}
