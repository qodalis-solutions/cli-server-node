import {
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliProcessCommand,
    getCliCaller,
    ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import type { PublicApiQuota } from './quota';
import { PublicApiAccountUsage, PublicApiError, PublicApiUsageService, USAGE_DAYS } from './usage-service';

/** The users plugin's permission to see every user's tokens: needed for another account's usage. */
export const TOKENS_READ_PERMISSION = 'tokens:read';

/** What the command reads of the users plugin (structural, like `PublicApiUsers`). */
export interface ApiCommandUsers {
    /** Finds a user by id or name (the users plugin's `userStore`); without it `--user` takes ids only. */
    userStore?: { getUser(idOrName: string): Promise<{ id: string; name: string } | undefined> };
    getUser(id: string): Promise<{ id: string; name: string } | undefined>;
    serverAuth: { hasPermission(ctx: { permissions: string[] }, permission: string): boolean };
}

/** `1000 per day, 60 per minute`; `unlimited`; `no API access` for a 0 limit. */
export function formatQuota(quota: PublicApiQuota): string {
    const limit = (n: number | null, unit: string) => (n === null ? undefined : `${n} per ${unit}`);
    if ((quota.requestsPerDay ?? 1) <= 0 || (quota.requestsPerMinute ?? 1) <= 0) return 'no API access';
    const parts = [limit(quota.requestsPerDay, 'day'), limit(quota.requestsPerMinute, 'minute')].filter(Boolean);
    return parts.length ? parts.join(', ') : 'unlimited';
}

/** The account's usage as text: today, the quota, then requests per day (rows) and token (columns) for `days` days. */
export function formatAccountUsage(name: string, usage: PublicApiAccountUsage, days: number): string {
    const lines = [`${name}: ${usage.today} request(s) today (every token, revoked ones too)`, `Quota: ${formatQuota(usage.quota)}`];
    if (usage.tokens.length === 0) {
        lines.push(`${name} has no API tokens.`);
        return lines.join('\n');
    }
    const dates = usage.tokens[0].usage.days.slice(-days).map((d) => d.date);
    const headers = ['Day', ...usage.tokens.map((t) => t.name), 'Total'];
    const rows = dates.map((date) => {
        const counts = usage.tokens.map((t) => t.usage.days.find((d) => d.date === date)?.requests ?? 0);
        return [date, ...counts.map(String), String(counts.reduce((a, b) => a + b, 0))];
    });
    const totals = usage.tokens.map((t) => t.usage.days.slice(-days).reduce((a, d) => a + d.requests, 0));
    rows.push(['Total', ...totals.map(String), String(totals.reduce((a, b) => a + b, 0))]);
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    // the day left-aligned, the counts right-aligned
    const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
    lines.push(line(headers), ...rows.map(line));
    return lines.join('\n');
}

class ApiUsageProcessor extends CliCommandProcessor {
    command = 'usage';
    description = 'Shows the public API requests of an account per token and day, with its quota (your own unless --user)';
    parameters = [
        new CliCommandParameterDescriptor('user', `Another account, by name or id (needs ${TOKENS_READ_PERMISSION})`, false, 'string'),
        new CliCommandParameterDescriptor('days', `How many days back, today included (1-${USAGE_DAYS}, default 7)`, false, 'number', undefined, 7),
        new CliCommandParameterDescriptor('json', 'Print the usage as JSON', false, 'boolean'),
    ];
    examples = [
        { command: 'api usage', description: 'Your requests of the last 7 days' },
        { command: 'api usage --user alice --days 30', description: "alice's requests of the last 30 days" },
    ];

    constructor(
        private readonly usage: PublicApiUsageService,
        private readonly users: ApiCommandUsers,
    ) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const rawDays = command.args?.days;
        const days = rawDays === undefined || rawDays === null ? 7 : rawDays === true ? NaN : Number(rawDays);
        if (!Number.isInteger(days) || days < 1 || days > USAGE_DAYS) return `Error: --days must be a whole number from 1 to ${USAGE_DAYS}`;
        const caller = getCliCaller();
        const userArg = command.args?.user;
        if (userArg === true || (userArg !== undefined && userArg !== null && String(userArg).trim() === '')) return 'Error: --user needs a name or id';
        let user: { id: string; name: string } | undefined;
        if (userArg === undefined || userArg === null) {
            if (!caller) return 'Error: no signed-in user: name the account with --user <name|id>';
            user = { id: caller.userId, name: caller.userName };
        } else {
            const key = String(userArg).trim();
            user = (await this.users.userStore?.getUser(key)) ?? (await this.users.getUser(key));
            if (!user) return `Error: user not found: ${key}`;
            if (caller && user.id !== caller.userId && !this.users.serverAuth.hasPermission({ permissions: caller.permissions }, TOKENS_READ_PERMISSION)) {
                return `Error: another account's usage needs ${TOKENS_READ_PERMISSION}`;
            }
        }
        let account: PublicApiAccountUsage;
        try {
            account = await this.usage.account(user.id);
        } catch (err) {
            if (err instanceof PublicApiError) return `Error: ${err.message}`;
            throw err;
        }
        if (command.args?.json) {
            const tokens = account.tokens.map((t) => ({ ...t, usage: { ...t.usage, days: t.usage.days.slice(-days) } }));
            return JSON.stringify({ user: { id: user.id, name: user.name }, days, today: account.today, quota: account.quota, tokens }, null, 2);
        }
        return formatAccountUsage(user.name, account, days);
    }
}

/**
 * `api` (= `api usage`), `api usage [--user <name|id>] [--days N] [--json]`: the public API usage of an account.
 * Your own with commands:execute; another account's with `tokens:read`, like `GET /tokens?all=true`.
 */
export class CliApiCommandProcessor extends CliCommandProcessor {
    command = 'api';
    description = 'Public API: requests per token and day, and the quota';
    module = 'public-api';
    icon = '🔌';
    processors: ICliCommandProcessor[];
    private readonly usageProcessor: ApiUsageProcessor;

    constructor(usage: PublicApiUsageService, users: ApiCommandUsers) {
        super();
        this.usageProcessor = new ApiUsageProcessor(usage, users);
        this.processors = [this.usageProcessor];
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.usageProcessor.handleAsync(command);
    }
}
