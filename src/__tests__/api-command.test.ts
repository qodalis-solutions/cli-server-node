/**
 * The public-api plugin's `api usage` terminal command through POST /execute: your own usage per token and day
 * with the quota, --days, --json, another account by name or id (tokens:read), no tokens, unknown users and bad
 * arguments.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import type { UsersPluginResult } from '../../plugins/users/index';
import { CliPublicApiBuilder, InMemoryPublicApiUsageStore, PublicApiQuota, formatQuota } from '@qodalis/cli-server-plugin-public-api';
import { protect, runCommand } from './command-test-helpers';

const disposables: Array<() => void> = [];
afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

const NOW = new Date('2026-11-25T12:00:00Z');

async function start(quota?: (userName: string) => PublicApiQuota) {
    const cli = createCliServer();
    cli.builder.addPermissions([{ name: 'rates:read', description: 'Rates', group: 'Rates' }]);
    const { plugin: users, tokens } = await protect(cli, {
        alice: ['commands:execute', 'rates:read'],
        auditor: ['commands:execute', 'tokens:read'],
    });
    const store = new InMemoryPublicApiUsageStore();
    const builder = new CliPublicApiBuilder().setUsers(users).setUsageStore(store).setClock(() => NOW);
    if (quota) builder.setQuota((caller) => quota(caller.userName));
    cli.mountPlugin(builder.build());
    disposables.push(() => {
        users.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return { cli, users, store, tokens };
}

/** A host token of the user and `requests` counted on each of the days (`{ '2026-11-25': 3 }`). */
async function tokenWithUsage(users: UsersPluginResult, store: InMemoryPublicApiUsageStore, userName: string, name: string, requests: Record<string, number>) {
    const user = (await users.userStore.getUser(userName))!;
    const { apiToken } = await users.apiTokens.create(user.id, { name, audience: 'host', permissions: ['rates:read'] });
    for (const [day, n] of Object.entries(requests)) {
        for (let i = 0; i < n; i++) await store.increment(apiToken.id, user.id, day);
    }
    return { user, tokenId: apiToken.id };
}

describe('api command', () => {
    it('is registered as api with usage, needing no permission beyond commands:execute', async () => {
        const { cli } = await start();
        const root = cli.registry.findProcessor('api')!;
        expect(root.requiredPermissions).toBeUndefined();
        expect(root.processors!.map((p) => [p.command, p.requiredPermissions])).toEqual([['usage', undefined]]);
    });

    it('api usage: your requests per day and token, totals, today and the quota', async () => {
        const { cli, users, store, tokens } = await start(() => ({ requestsPerDay: 1000, requestsPerMinute: 60 }));
        await tokenWithUsage(users, store, 'alice', 'website', { '2026-11-25': 3, '2026-11-24': 2, '2026-11-10': 9 });
        await tokenWithUsage(users, store, 'alice', 'ci-bot', { '2026-11-25': 10 });
        const { text } = await runCommand(cli, 'api usage --days 3', tokens.alice);
        expect(text).toBe(
            [
                'alice: 13 request(s) today (every token, revoked ones too)',
                'Quota: 1000 per day, 60 per minute',
                'Day         website  ci-bot  Total',
                '2026-11-23        0       0      0',
                '2026-11-24        2       0      2',
                '2026-11-25        3      10     13',
                'Total             5      10     15',
            ].join('\n'),
        );
        // api alone is api usage, 7 days by default
        expect((await runCommand(cli, 'api', tokens.alice)).text.split('\n')).toHaveLength(2 + 1 + 7 + 1);
        expect((await runCommand(cli, 'api usage --days 30', tokens.alice)).text).toContain('Total            14      10     24');
    });

    it('--json: the account usage with the days asked for', async () => {
        const { cli, users, store, tokens } = await start();
        const { user, tokenId } = await tokenWithUsage(users, store, 'alice', 'website', { '2026-11-25': 4 });
        const body = JSON.parse((await runCommand(cli, 'api usage --days 2 --json', tokens.alice)).text);
        expect(body).toEqual({
            user: { id: user.id, name: 'alice' },
            days: 2,
            today: 4,
            quota: { requestsPerDay: null, requestsPerMinute: null },
            tokens: [
                {
                    tokenId,
                    name: 'website',
                    usage: { today: 4, last30Days: 4, days: [{ date: '2026-11-24', requests: 0 }, { date: '2026-11-25', requests: 4 }] },
                },
            ],
        });
    });

    it('an account without tokens, unlimited', async () => {
        const { cli, tokens } = await start();
        expect((await runCommand(cli, 'api usage', tokens.alice)).text).toBe(
            ['alice: 0 request(s) today (every token, revoked ones too)', 'Quota: unlimited', 'alice has no API tokens.'].join('\n'),
        );
    });

    it("another account's usage needs tokens:read; by name or id", async () => {
        const { cli, users, store, tokens } = await start();
        const { user } = await tokenWithUsage(users, store, 'alice', 'website', { '2026-11-25': 1 });
        expect((await runCommand(cli, 'api usage --user auditor', tokens.alice)).text).toBe("Error: another account's usage needs tokens:read");
        expect((await runCommand(cli, 'api usage --user alice', tokens.auditor)).text).toContain('alice: 1 request(s) today');
        expect((await runCommand(cli, `api usage --user ${user.id}`, tokens.auditor)).text).toContain('alice: 1 request(s) today');
        expect((await runCommand(cli, 'api usage --user ALICE', tokens.root)).text).toContain('alice: 1 request(s) today');
        // naming yourself needs nothing more
        expect((await runCommand(cli, 'api usage --user alice', tokens.alice)).text).toContain('alice: 1 request(s) today');
    });

    it('refuses unknown users and bad arguments', async () => {
        const { cli, tokens } = await start();
        expect((await runCommand(cli, 'api usage --user nobody', tokens.root)).text).toBe('Error: user not found: nobody');
        expect((await runCommand(cli, 'api usage --user', tokens.root)).text).toBe('Error: --user needs a name or id');
        for (const bad of ['0', '31', 'x', '2.5']) {
            expect((await runCommand(cli, `api usage --days ${bad}`, tokens.root)).text).toBe('Error: --days must be a whole number from 1 to 30');
        }
    });

    it('the quota as the resolver gives it for the account', async () => {
        const { cli, tokens } = await start((name) => (name === 'alice' ? { requestsPerDay: 0, requestsPerMinute: null } : { requestsPerDay: null, requestsPerMinute: 5 }));
        expect((await runCommand(cli, 'api usage', tokens.alice)).text).toContain('Quota: no API access');
        expect((await runCommand(cli, 'api usage', tokens.auditor)).text).toContain('Quota: 5 per minute');
    });

    it('anonymous callers are refused (the users plugin protects the server)', async () => {
        const { cli } = await start();
        expect((await runCommand(cli, 'api usage')).status).toBe(401);
    });

    it('formatQuota', () => {
        expect(formatQuota({ requestsPerDay: null, requestsPerMinute: null })).toBe('unlimited');
        expect(formatQuota({ requestsPerDay: 10, requestsPerMinute: null })).toBe('10 per day');
        expect(formatQuota({ requestsPerDay: 10, requestsPerMinute: -1 })).toBe('no API access');
    });
});
