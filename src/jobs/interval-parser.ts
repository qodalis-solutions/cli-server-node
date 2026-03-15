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
