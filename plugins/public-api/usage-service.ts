import { IPublicApiUsageStore } from './usage-store';
import { PublicApiQuota, PublicApiQuotaResolver, QcliCaller, UNLIMITED, dayBefore, dayWindow, normalizeLimit } from './quota';

/** Days shown in a token's usage (the last one today). */
export const USAGE_DAYS = 30;

/** One UTC day of a token's usage. */
export interface ApiTokenUsageDay {
    date: string;
    requests: number;
}

/** A token's requests (the users plugin's `ApiTokenUsage`): today and the last 30 UTC days. */
export interface ApiTokenUsage {
    today: number;
    last30Days: number;
    /** Exactly 30 entries, oldest first, the last one today; days without requests included. */
    days: ApiTokenUsageDay[];
}

/** A token of the account and its usage. */
export interface PublicApiTokenUsage {
    tokenId: string;
    name: string;
    usage: ApiTokenUsage;
}

/** An account's usage, for a host's own pages (`publicApi.usage.account(userId)`). */
export interface PublicApiAccountUsage {
    /** The account's requests today (UTC), every token included, revoked ones too. */
    today: number;
    /** The account's limits, from the quota resolver (unlimited without one). */
    quota: PublicApiQuota;
    /** The account's current tokens (both audiences), oldest first. */
    tokens: PublicApiTokenUsage[];
}

/** The users-plugin members the usage service reads. */
export interface PublicApiUsageUsers {
    apiTokens: { list(userId: string): Promise<Array<{ id: string; name: string; usage?: ApiTokenUsage }>> };
    getUser(id: string): Promise<{ id: string; name: string } | undefined>;
    /** The users plugin's `authService`: the account's effective permissions for the quota resolver. */
    authService?: { getEffectivePermissions(user: { id: string; name: string }): Promise<string[]> };
}

/** An error with the HTTP status a host would answer (`status`), like the users plugin's. */
export class PublicApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'PublicApiError';
    }
}

/** Reads the usage counters for token views and account pages. */
export class PublicApiUsageService {
    constructor(
        private readonly store: IPublicApiUsageStore,
        private readonly users: PublicApiUsageUsers,
        private readonly quota: () => PublicApiQuotaResolver | undefined,
        private readonly now: () => Date,
    ) {}

    /** The usage of each token: 30 dense UTC days ending today (the users plugin's token usage provider). */
    async tokenUsage(tokenIds: string[]): Promise<Record<string, ApiTokenUsage>> {
        const today = this.now();
        const dates = Array.from({ length: USAGE_DAYS }, (_, i) => dayBefore(today, USAGE_DAYS - 1 - i));
        const counts = tokenIds.length > 0 ? await this.store.tokenDays(tokenIds, dates[0], dayWindow(today)) : {};
        const out: Record<string, ApiTokenUsage> = {};
        for (const id of tokenIds) {
            const perDay = counts[id] ?? {};
            const days = dates.map((date) => ({ date, requests: perDay[date] ?? 0 }));
            out[id] = {
                today: days[days.length - 1].requests,
                last30Days: days.reduce((sum, d) => sum + d.requests, 0),
                days,
            };
        }
        return out;
    }

    /**
     * The account's usage: today's requests, its quota (the resolver called with the user
     * and their effective permissions, no token) and its tokens. 404 `user not found`.
     */
    async account(userId: string): Promise<PublicApiAccountUsage> {
        const user = typeof userId === 'string' && userId ? await this.users.getUser(userId) : undefined;
        if (!user) throw new PublicApiError(404, 'user not found');
        const permissions = this.users.authService ? await this.users.authService.getEffectivePermissions(user) : [];
        const caller: QcliCaller = { userId: user.id, userName: user.name, tokenId: null, audience: null, permissions };
        const resolver = this.quota();
        const resolved = resolver ? await resolver(caller) : UNLIMITED;
        const quota: PublicApiQuota = {
            requestsPerDay: normalizeLimit(resolved?.requestsPerDay),
            requestsPerMinute: normalizeLimit(resolved?.requestsPerMinute),
        };
        // the views carry the usage (this plugin is their provider): one read of the counters
        const tokens = await this.users.apiTokens.list(user.id);
        const missing = tokens.filter((t) => !t.usage).map((t) => t.id);
        const usage = missing.length > 0 ? await this.tokenUsage(missing) : {};
        return {
            today: await this.store.accountCount(user.id, dayWindow(this.now())),
            quota,
            tokens: tokens.map((t) => ({ tokenId: t.id, name: t.name, usage: t.usage ?? usage[t.id] })),
        };
    }
}
