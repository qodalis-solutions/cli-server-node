const DAY_MS = 24 * 60 * 60 * 1000;

/** Default and largest number of columns of a chart. */
export const DEFAULT_CHART_BUCKETS = 24;
export const MAX_CHART_BUCKETS = 200;

/** A request value that answers 400 `{ error }`. */
export class QueryError extends Error {}

/**
 * Parses a query time: ISO 8601, read as UTC when it names no offset. Undefined when
 * absent; throws {@link QueryError} for a bad value.
 */
export function parseQueryTime(value: unknown, name: string): Date | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new QueryError(`${name} must be an ISO 8601 date`);
    const text = value.trim();
    // `2026-11-05T10:00` has no offset: UTC, not the server's local time
    const withZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text}Z` : text;
    const date = /^\d{4}-\d{2}-\d{2}/.test(text) ? new Date(withZone) : new Date(NaN);
    if (Number.isNaN(date.getTime())) throw new QueryError(`${name} must be an ISO 8601 date`);
    return date;
}

/** The number of columns asked for, clamped to 1..200 (24 when absent or not a number). */
export function clampBuckets(value: unknown): number {
    const parsed = typeof value === 'string' ? parseInt(value, 10) : NaN;
    if (Number.isNaN(parsed)) return DEFAULT_CHART_BUCKETS;
    return Math.min(Math.max(parsed, 1), MAX_CHART_BUCKETS);
}

/**
 * The range `[from, to)` of a chart: `to` defaults to now, `from` to 24 hours before `to`.
 * Throws {@link QueryError} for a bad value or an empty range.
 */
export function resolveRange(fromValue: unknown, toValue: unknown, fromName: string, toName: string, now = new Date()): { from: Date; to: Date } {
    const to = parseQueryTime(toValue, toName) ?? now;
    const from = parseQueryTime(fromValue, fromName) ?? new Date(to.getTime() - DAY_MS);
    if (from.getTime() >= to.getTime()) throw new QueryError(`${fromName} must be before ${toName}`);
    return { from, to };
}
