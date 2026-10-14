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

/** The client IP. `X-Forwarded-For` is only honoured when `trustProxy` is set. */
export function clientIp(req: Request, trustProxy: boolean): string {
    if (trustProxy) {
        const header = req.headers['x-forwarded-for'];
        const value = Array.isArray(header) ? header[0] : header;
        const first = value?.split(',')[0]?.trim();
        if (first) return first;
    }
    return req.socket?.remoteAddress ?? 'unknown';
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
