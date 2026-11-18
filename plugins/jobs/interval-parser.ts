const INTERVAL_REGEX = /^(\d+)(s|m|h|d)$/;

const UNIT_TO_MS: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

/**
 * Parse an interval string like "30s", "5m", "1h", "1d" into milliseconds.
 * Returns `null` if the format is invalid.
 */
export function parseInterval(interval: string): number | null {
    const match = interval.match(INTERVAL_REGEX);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    if (value <= 0) return null;

    return value * UNIT_TO_MS[unit];
}

/**
 * Parse a duration given as an interval string ("30s", "6h", "30d") or as milliseconds.
 * Returns `null` if it is not a positive duration.
 */
export function parseDuration(value: string | number): number | null {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    return typeof value === 'string' ? parseInterval(value) : null;
}

/**
 * Format milliseconds as an interval string in the largest unit that divides it ("1d", "90m"),
 * else in whole seconds, rounded up.
 */
export function formatDuration(ms: number): string {
    for (const unit of ['d', 'h', 'm', 's']) {
        if (ms % UNIT_TO_MS[unit] === 0) return `${ms / UNIT_TO_MS[unit]}${unit}`;
    }
    return `${Math.ceil(ms / 1_000)}s`;
}
