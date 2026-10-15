import { createHash } from 'crypto';
import type { Request } from 'express';
import { permissionMatches } from './permissions';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/g;

/** True when the string contains control characters (including ANSI ESC). */
export function hasControlChars(value: string): boolean {
    return CONTROL_CHARS.test(value);
}

/** Removes control characters and truncates, for values written to the audit log. */
export function sanitize(value: string, maxLength?: number): string {
    const clean = value.replace(CONTROL_CHARS_GLOBAL, '');
    return maxLength !== undefined && clean.length > maxLength ? clean.slice(0, maxLength) : clean;
}

/** SHA-256 hex digest of a token; stores only ever see this. */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

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
 * The client IP: the socket address, or with `trustProxy` (a hop count,
 * `true` = 1) the `X-Forwarded-For` entry at index `len - hops`.
 */
export function clientIp(req: Request, trustProxy: boolean | number): string {
    return forwardedClient(req.headers['x-forwarded-for'], trustedProxyHops(trustProxy)) ?? req.socket?.remoteAddress ?? 'unknown';
}

/** Permissions of `target` not covered by any permission in `caller` (wildcard-aware). */
export function uncoveredPermissions(caller: readonly string[], target: readonly string[]): string[] {
    return target.filter((t) => !caller.some((c) => permissionMatches(c, t)));
}

/** Sliding-window per-key attempt limiter. */
export class RateLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(private readonly max: number, private readonly windowMs: number) {}

    /** Records an attempt; returns false when the key is over the limit. */
    tryAcquire(key: string): boolean {
        const now = Date.now();
        const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (list.length >= this.max) {
            this.hits.set(key, list);
            return false;
        }
        list.push(now);
        this.hits.set(key, list);
        return true;
    }

    /** Drops expired windows. */
    sweep(): void {
        const now = Date.now();
        for (const [key, list] of this.hits) {
            const live = list.filter((t) => now - t < this.windowMs);
            if (live.length === 0) this.hits.delete(key);
            else this.hits.set(key, live);
        }
    }
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
