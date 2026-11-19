/**
 * Where the public API's request counters are kept: one counter per token and window
 * (a UTC day `yyyy-MM-dd` or a UTC minute `yyyy-MM-ddTHH:mm`), tagged with the token's
 * user so limits are checked per account. A persistent store shared by several
 * processes makes their limits shared too.
 */
export interface IPublicApiUsageStore {
    /** Adds one request to the token's counter for `window`; returns the token's new count. */
    increment(tokenId: string, userId: string, window: string): Promise<number>;
    /** Takes one request back (a refused request the guard counted first). */
    decrement(tokenId: string, window: string): Promise<void>;
    /** The sum over every token of the account (revoked tokens included) for `window`. */
    accountCount(userId: string, window: string): Promise<number>;
    /** Day counters of the tokens from `fromDay` to `toDay` (inclusive): `{ tokenId: { day: count } }`, days without requests left out. */
    tokenDays(tokenIds: string[], fromDay: string, toDay: string): Promise<Record<string, Record<string, number>>>;
    /** Removes day counters before `beforeDay` and minute counters before `beforeMinute`. */
    prune(beforeDay: string, beforeMinute: string): Promise<void>;
}

/** A day window is `yyyy-MM-dd`; a minute window is longer (`yyyy-MM-ddTHH:mm`). */
const isDay = (window: string) => window.length === 10;

/** Counters in memory (the default): one process; lost on restart. */
export class InMemoryPublicApiUsageStore implements IPublicApiUsageStore {
    /** `${tokenId}|${window}` → the token's user and count. */
    private readonly tokens = new Map<string, { tokenId: string; userId: string; window: string; count: number }>();
    /** `${userId}|${window}` → the account's sum. */
    private readonly accounts = new Map<string, number>();

    async increment(tokenId: string, userId: string, window: string): Promise<number> {
        const key = `${tokenId}|${window}`;
        const entry = this.tokens.get(key) ?? { tokenId, userId, window, count: 0 };
        entry.count++;
        this.tokens.set(key, entry);
        const accountKey = `${entry.userId}|${window}`;
        this.accounts.set(accountKey, (this.accounts.get(accountKey) ?? 0) + 1);
        return entry.count;
    }

    async decrement(tokenId: string, window: string): Promise<void> {
        const key = `${tokenId}|${window}`;
        const entry = this.tokens.get(key);
        if (!entry || entry.count <= 0) return;
        entry.count--;
        const accountKey = `${entry.userId}|${window}`;
        const sum = (this.accounts.get(accountKey) ?? 1) - 1;
        if (sum > 0) this.accounts.set(accountKey, sum);
        else this.accounts.delete(accountKey);
        if (entry.count === 0) this.tokens.delete(key);
    }

    async accountCount(userId: string, window: string): Promise<number> {
        return this.accounts.get(`${userId}|${window}`) ?? 0;
    }

    async tokenDays(tokenIds: string[], fromDay: string, toDay: string): Promise<Record<string, Record<string, number>>> {
        const wanted = new Set(tokenIds);
        const out: Record<string, Record<string, number>> = {};
        for (const entry of this.tokens.values()) {
            if (!wanted.has(entry.tokenId) || !isDay(entry.window) || entry.window < fromDay || entry.window > toDay) continue;
            (out[entry.tokenId] ??= {})[entry.window] = entry.count;
        }
        return out;
    }

    async prune(beforeDay: string, beforeMinute: string): Promise<void> {
        for (const [key, entry] of this.tokens) {
            if (entry.window < (isDay(entry.window) ? beforeDay : beforeMinute)) {
                this.tokens.delete(key);
                const accountKey = `${entry.userId}|${entry.window}`;
                const sum = (this.accounts.get(accountKey) ?? 0) - entry.count;
                if (sum > 0) this.accounts.set(accountKey, sum);
                else this.accounts.delete(accountKey);
            }
        }
    }
}
