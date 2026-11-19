/**
 * Quotas of the public API: the limits a host returns for a caller, the fixed UTC
 * windows they are counted in, and the `X-RateLimit-*` headers.
 */

/**
 * The caller of a guarded route (`req.qcliCaller`, set by the users plugin's guards);
 * the same shape as the users plugin's `QcliCaller`.
 */
export interface QcliCaller {
    userId: string;
    userName: string;
    /** The API token's id; null for a session or an auth-adapter sign-in. */
    tokenId: string | null;
    /** `cli` or `host` for a token, null without one. */
    audience: 'cli' | 'host' | null;
    /** The live effective permissions, narrowed to the token's scope. */
    permissions: string[];
}

/** An account's limits: null = unlimited; 0 (or negative) = no API access. */
export interface PublicApiQuota {
    requestsPerDay: number | null;
    requestsPerMinute: number | null;
}

/** Returns the caller's limits (host-supplied; none = unlimited). May be async. */
export type PublicApiQuotaResolver = (caller: QcliCaller) => PublicApiQuota | Promise<PublicApiQuota>;

export const UNLIMITED: PublicApiQuota = { requestsPerDay: null, requestsPerMinute: null };

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** The UTC day window `yyyy-MM-dd`. */
export function dayWindow(at: Date): string {
    return at.toISOString().slice(0, 10);
}

/** The UTC minute window `yyyy-MM-ddTHH:mm`. */
export function minuteWindow(at: Date): string {
    return at.toISOString().slice(0, 16);
}

/** Whole seconds (at least 1) until the next UTC midnight. */
export function secondsToNextDay(at: Date): number {
    const ms = at.getTime();
    return Math.max(1, Math.ceil((Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS - ms) / 1000));
}

/** Whole seconds (at least 1) until the next UTC minute. */
export function secondsToNextMinute(at: Date): number {
    const ms = at.getTime();
    return Math.max(1, Math.ceil((Math.floor(ms / MINUTE_MS) * MINUTE_MS + MINUTE_MS - ms) / 1000));
}

/** The day `days` days before `at` (UTC). */
export function dayBefore(at: Date, days: number): string {
    return dayWindow(new Date(at.getTime() - days * DAY_MS));
}

/**
 * A limit as the guard applies it: null/undefined = unlimited, a number is floored and
 * read as 0 when negative. Anything else is a host error (the guard answers 500).
 */
export function normalizeLimit(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new TypeError(`public-api: a quota limit must be a number or null, got ${String(value)}`);
    }
    return value <= 0 ? 0 : Math.floor(value);
}

/** The `X-RateLimit-*` values for an answer (undefined when both limits are null). */
export interface RateLimitHeaders {
    limit: number;
    remaining: number;
    reset: number;
}

/**
 * The headers: the daily limit when set, otherwise the per-minute limit. `dayCount` and
 * `minuteCount` are the account's counts including this request.
 */
export function rateLimitHeaders(
    quota: { perDay: number | null; perMinute: number | null },
    dayCount: number,
    minuteCount: number,
    at: Date,
): RateLimitHeaders | undefined {
    if (quota.perDay !== null) {
        return { limit: quota.perDay, remaining: Math.max(0, quota.perDay - dayCount), reset: secondsToNextDay(at) };
    }
    if (quota.perMinute !== null) {
        return { limit: quota.perMinute, remaining: Math.max(0, quota.perMinute - minuteCount), reset: secondsToNextMinute(at) };
    }
    return undefined;
}
