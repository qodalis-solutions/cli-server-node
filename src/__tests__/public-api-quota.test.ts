/**
 * The public-api guard: host tokens only, the route's permission, per-account daily and
 * per-minute quotas (fixed UTC windows) with X-RateLimit headers, usage on token views.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { Router } from 'express';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import {
    CliPublicApiBuilder,
    InMemoryPublicApiUsageStore,
    PublicApiPluginResult,
    PublicApiQuota,
    QcliCaller,
} from '@qodalis/cli-server-plugin-public-api';
import { BASE, ROOT_PASS, auth, login } from './users-test-helpers';

const START = '2026-11-19T23:59:30Z';
const RATES = [
    { name: 'rates:read', description: 'Official exchange rates', group: 'Rates' },
    { name: 'banks:read', description: 'Banks and their buy and sell rates', group: 'Rates' },
];

interface Harness {
    cli: CliServerResult;
    server: http.Server;
    users: UsersPluginResult;
    api: PublicApiPluginResult;
    store: InMemoryPublicApiUsageStore;
    clock: { now: Date };
    advance(seconds: number): void;
    hostToken(userName?: string, permissions?: string[]): Promise<{ token: string; id: string; userId: string }>;
}

const disposables: Array<() => void | Promise<void>> = [];

afterEach(async () => {
    vi.restoreAllMocks();
    while (disposables.length) await disposables.pop()!();
});

async function start(configure: (b: CliPublicApiBuilder) => void = () => undefined): Promise<Harness> {
    const cli = createCliServer();
    cli.builder.addPermissions(RATES);
    const users = new CliUsersBuilder()
        .setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4, ipRateLimit: 10_000 })
        .build();
    await users.ready;
    cli.mountPlugin(users);
    await users.groupStore.createGroup({ name: 'customers', permissions: ['commands:execute', 'rates:read', 'banks:read'] });

    const clock = { now: new Date(START) };
    const store = new InMemoryPublicApiUsageStore();
    const builder = new CliPublicApiBuilder().setUsers(users).setUsageStore(store).setClock(() => clock.now);
    configure(builder);
    const api = builder.build();
    cli.mountPlugin(api);
    cli.app.get('/v1/rates', api.guard('rates:read'), (req, res) => {
        res.json({ tokenId: req.qcliCaller!.tokenId });
    });
    cli.app.get('/v1/open', api.guard(), (_req, res) => {
        res.json({ ok: true });
    });
    cli.app.get('/v1/missing', api.guard('rates:read'), (_req, res) => {
        res.status(404).json({ error: 'no such rate' });
    });
    // One listening server per test (supertest otherwise opens and closes one per request),
    // closed and awaited after the test
    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    disposables.push(async () => {
        users.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    });

    const userIds = new Map<string, string>();
    let n = 0;
    return {
        cli,
        server,
        users,
        api,
        store,
        clock,
        advance: (seconds) => {
            clock.now = new Date(clock.now.getTime() + seconds * 1000);
        },
        hostToken: async (userName = 'alice', permissions = ['rates:read']) => {
            let userId = userIds.get(userName);
            if (!userId) {
                const user = await users.userStore.createUser({ name: userName, email: `${userName}@example.com`, groups: ['customers'] });
                await users.authService.setPassword(user.id, `${userName}pass`);
                userId = user.id;
                userIds.set(userName, userId);
            }
            const created = await users.apiTokens.create(userId, { name: `site ${++n}`, audience: 'host', permissions });
            return { token: created.token, id: created.apiToken.id, userId };
        },
    };
}

const day = (h: Harness) => h.clock.now.toISOString().slice(0, 10);
const minute = (h: Harness) => h.clock.now.toISOString().slice(0, 16);

describe('public-api guard', () => {
    it('unlimited, no headers', async () => {
        const h = await start();
        const { token, id, userId } = await h.hostToken();
        const res = await request(h.server).get('/v1/rates').set(auth(token));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ tokenId: id });
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
        expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
        expect(res.headers['x-ratelimit-reset']).toBeUndefined();
        // counted all the same (usage)
        expect(await h.store.accountCount(userId, day(h))).toBe(1);
    });

    it('refusals', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 10, requestsPerMinute: null })));
        const host = await h.hostToken();
        const app = h.cli.app;

        const none = await request(app).get('/v1/rates');
        expect(none.status).toBe(401);
        expect(none.body).toEqual({ error: 'unauthorized' });

        const unknown = await request(app).get('/v1/rates').set(auth('qcli_pat_unknown'));
        expect(unknown.status).toBe(401);
        expect(unknown.body).toEqual({ error: 'invalid or expired token' });

        const session = (await login(app, 'alice', 'alicepass')).token;
        const s = await request(app).get('/v1/rates').set(auth(session));
        expect(s.status).toBe(403);
        expect(s.body).toEqual({ error: 'forbidden: a host token is required' });
        expect(s.headers['x-ratelimit-limit']).toBeUndefined();

        const created = await request(app).post(`${BASE}/tokens`).set(auth(session)).send({ name: 'cli' });
        expect(created.status).toBe(201);
        const c = await request(app).get('/v1/rates').set(auth(created.body.token));
        expect(c.status).toBe(403);
        expect(c.body).toEqual({ error: 'forbidden: a host token is required' });

        const banks = await h.hostToken('alice', ['banks:read']);
        const denied = await request(app).get('/v1/rates').set(auth(banks.token));
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: 'forbidden: missing permission rates:read' });
        expect(denied.headers['x-ratelimit-limit']).toBeUndefined();

        // none of them was counted
        expect(await h.store.accountCount(host.userId, day(h))).toBe(0);
        expect(await h.store.accountCount(host.userId, minute(h))).toBe(0);

        const open = await request(app).get('/v1/open').set(auth(banks.token));
        expect(open.status).toBe(200);
        expect(await h.store.accountCount(host.userId, day(h))).toBe(1);
    });

    it('daily headers and limit', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 3, requestsPerMinute: null })));
        const { token } = await h.hostToken();
        for (const remaining of ['2', '1', '0']) {
            const res = await request(h.server).get('/v1/rates').set(auth(token));
            expect(res.status).toBe(200);
            expect(res.headers['x-ratelimit-limit']).toBe('3');
            expect(res.headers['x-ratelimit-remaining']).toBe(remaining);
            expect(res.headers['x-ratelimit-reset']).toBe('30');
            expect(res.headers['retry-after']).toBeUndefined();
        }
        const refused = await request(h.server).get('/v1/rates').set(auth(token));
        expect(refused.status).toBe(429);
        expect(refused.body).toEqual({ error: 'quota exceeded: 3 requests per day' });
        expect(refused.headers['retry-after']).toBe('30');
        expect(refused.headers['x-ratelimit-limit']).toBe('3');
        expect(refused.headers['x-ratelimit-remaining']).toBe('0');
        expect(refused.headers['x-ratelimit-reset']).toBe('30');
    });

    it('minute limit', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: null, requestsPerMinute: 2 })));
        const { token } = await h.hostToken();
        for (const remaining of ['1', '0']) {
            const res = await request(h.server).get('/v1/rates').set(auth(token));
            expect(res.status).toBe(200);
            expect(res.headers['x-ratelimit-limit']).toBe('2');
            expect(res.headers['x-ratelimit-remaining']).toBe(remaining);
            expect(res.headers['x-ratelimit-reset']).toBe('30');
        }
        const refused = await request(h.server).get('/v1/rates').set(auth(token));
        expect(refused.status).toBe(429);
        expect(refused.body).toEqual({ error: 'too many requests: 2 per minute' });
        expect(refused.headers['retry-after']).toBe('30');
        expect(refused.headers['x-ratelimit-limit']).toBe('2');
        expect(refused.headers['x-ratelimit-remaining']).toBe('0');
    });

    it('both limits, headers describe the day', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 100, requestsPerMinute: 2 })));
        const { token } = await h.hostToken();
        const first = await request(h.server).get('/v1/rates').set(auth(token));
        expect(first.headers['x-ratelimit-limit']).toBe('100');
        expect(first.headers['x-ratelimit-remaining']).toBe('99');
        await request(h.server).get('/v1/rates').set(auth(token));
        const refused = await request(h.server).get('/v1/rates').set(auth(token));
        expect(refused.status).toBe(429);
        expect(refused.body).toEqual({ error: 'too many requests: 2 per minute' });
        expect(refused.headers['x-ratelimit-limit']).toBe('100');
        expect(refused.headers['x-ratelimit-remaining']).toBe('0');
        expect(refused.headers['retry-after']).toBe('30');
    });

    it.each([0, -5])('zero limit returns 403 (%d)', async (limit) => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: limit, requestsPerMinute: null })));
        const { token, userId } = await h.hostToken();
        const res = await request(h.server).get('/v1/rates').set(auth(token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden: no API access' });
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
        expect(await h.store.accountCount(userId, day(h))).toBe(0);
    });

    it('quota is per account', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 3, requestsPerMinute: null })));
        const a = await h.hostToken();
        const b = await h.hostToken();
        expect((await request(h.server).get('/v1/rates').set(auth(a.token))).status).toBe(200);
        expect((await request(h.server).get('/v1/rates').set(auth(a.token))).status).toBe(200);
        const third = await request(h.server).get('/v1/rates').set(auth(b.token));
        expect(third.status).toBe(200);
        expect(third.headers['x-ratelimit-remaining']).toBe('0');
        expect((await request(h.server).get('/v1/rates').set(auth(a.token))).status).toBe(429);
        expect((await request(h.server).get('/v1/rates').set(auth(b.token))).status).toBe(429);
        const other = await h.hostToken('bob');
        expect((await request(h.server).get('/v1/rates').set(auth(other.token))).status).toBe(200);
    });

    it('quota: revoked tokens still count', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 2, requestsPerMinute: null })));
        const a = await h.hostToken();
        expect((await request(h.server).get('/v1/rates').set(auth(a.token))).status).toBe(200);
        expect((await request(h.server).get('/v1/rates').set(auth(a.token))).status).toBe(200);
        expect(await h.users.apiTokens.revoke(a.userId, a.id)).toBe(true);
        const b = await h.hostToken();
        const res = await request(h.server).get('/v1/rates').set(auth(b.token));
        expect(res.status).toBe(429);
        expect(res.body).toEqual({ error: 'quota exceeded: 2 requests per day' });
    });

    it('quota: the day rolls over at UTC midnight', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 1, requestsPerMinute: null })));
        const { token } = await h.hostToken();
        expect((await request(h.server).get('/v1/rates').set(auth(token))).status).toBe(200);
        const refused = await request(h.server).get('/v1/rates').set(auth(token));
        expect(refused.status).toBe(429);
        expect(refused.headers['retry-after']).toBe('30');
        h.advance(31); // 00:00:01Z: a new day
        const next = await request(h.server).get('/v1/rates').set(auth(token));
        expect(next.status).toBe(200);
        expect(next.headers['x-ratelimit-reset']).toBe('86399');
        h.advance(30); // 00:00:31Z
        const later = await request(h.server).get('/v1/rates').set(auth(token));
        expect(later.status).toBe(429);
        expect(later.headers['x-ratelimit-reset']).toBe('86369');
        expect(later.headers['retry-after']).toBe('86369');
    });

    it('quota: parallel requests admit exactly the limit', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 10, requestsPerMinute: null })));
        const { token, userId } = await h.hostToken();
        const server = h.server;
        {
            const results = await Promise.all(
                Array.from({ length: 50 }, () => request(server).get('/v1/rates').set(auth(token)).then((r) => r.status)),
            );
            expect(results.filter((s) => s === 200)).toHaveLength(10);
            expect(results.filter((s) => s === 429)).toHaveLength(40);
            expect(await h.store.accountCount(userId, day(h))).toBe(10);
        }
    });

    it('quota resolver throws: 500, not counted', async () => {
        let broken = true;
        const h = await start((b) =>
            b.setQuota(() => {
                if (broken) throw new Error('db down');
                return { requestsPerDay: 3, requestsPerMinute: null };
            }),
        );
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { token, userId } = await h.hostToken();
        const res = await request(h.server).get('/v1/rates').set(auth(token));
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internal server error' });
        expect(res.text).not.toContain('db down');
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
        expect(errors).toHaveBeenCalled();
        expect(await h.store.accountCount(userId, day(h))).toBe(0);
        broken = false;
        const next = await request(h.server).get('/v1/rates').set(auth(token));
        expect(next.status).toBe(200);
        expect(next.headers['x-ratelimit-remaining']).toBe('2');
    });

    it('a rejected async resolver is a 500 too', async () => {
        const h = await start((b) => b.setQuota(async () => Promise.reject(new Error('db down'))));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { token } = await h.hostToken();
        const res = await request(h.server).get('/v1/rates').set(auth(token));
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internal server error' });
    });

    it('a resolver returning null is unlimited (still counted)', async () => {
        const h = await start((b) => b.setQuota(() => null as unknown as PublicApiQuota));
        const { token, userId } = await h.hostToken();
        const res = await request(h.server).get('/v1/rates').set(auth(token));
        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
        expect(await h.store.accountCount(userId, day(h))).toBe(1);
    });

    it('a failing usage store: 500, the handler does not run', async () => {
        const h = await start();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(h.store, 'increment').mockRejectedValue(new Error('usage db down'));
        const { token } = await h.hostToken();
        const res = await request(h.server).get('/v1/rates').set(auth(token));
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internal server error' });
        expect(res.text).not.toContain('usage db down');
    });

    it('stacked guards count a request once', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 2, requestsPerMinute: null })));
        const router = Router();
        router.use(h.api.guard());
        router.get('/rates', h.api.guard('rates:read'), (_req, res) => res.json({ ok: true }));
        h.cli.app.use('/v2', router);
        const { token, userId } = await h.hostToken();
        const first = await request(h.server).get('/v2/rates').set(auth(token));
        expect(first.status).toBe(200);
        expect(first.headers['x-ratelimit-remaining']).toBe('1');
        expect((await request(h.server).get('/v2/rates').set(auth(token))).status).toBe(200);
        expect((await request(h.server).get('/v2/rates').set(auth(token))).status).toBe(429);
        expect(await h.store.accountCount(userId, day(h))).toBe(2);
        expect((await h.api.usage.account(userId)).today).toBe(2);
    });

    it('stacked guards: a later guard checks its own permission', async () => {
        const h = await start();
        const router = Router();
        router.use(h.api.guard());
        router.get('/rates', h.api.guard('rates:read'), (_req, res) => res.json({ ok: true }));
        h.cli.app.use('/v2', router);
        const banks = await h.hostToken('alice', ['banks:read']);
        const res = await request(h.server).get('/v2/rates').set(auth(banks.token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden: missing permission rates:read' });
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
        // refused by a guard's permission: not counted
        expect(await h.store.accountCount(banks.userId, day(h))).toBe(0);
        expect(await h.store.accountCount(banks.userId, minute(h))).toBe(0);
    });

    it('a client that goes away while waiting is not counted', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let entered!: () => void;
        const waiting = new Promise<void>((r) => (entered = r));
        const h = await start((b) =>
            b.setQuota(async () => {
                entered();
                await gate;
                return { requestsPerDay: 5, requestsPerMinute: null };
            }),
        );
        const { token, userId } = await h.hostToken();
        {
            const port = (h.server.address() as { port: number }).port;
            const req = http.get({ host: '127.0.0.1', port, path: '/v1/rates', headers: auth(token) });
            req.on('error', () => undefined);
            await waiting;
            req.destroy();
            await new Promise((r) => setTimeout(r, 50));
            release();
            await new Promise((r) => setTimeout(r, 50));
            expect(await h.store.accountCount(userId, day(h))).toBe(0);
        }
    });

    it.each(['minute increment', 'account count'])('a store failing on the %s: 500 and the increments are taken back', async (failing) => {
        const h = await start();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const increment = h.store.increment.bind(h.store);
        if (failing === 'minute increment') {
            vi.spyOn(h.store, 'increment').mockImplementation(async (tokenId, userId, window) => {
                if (window.length > 10) throw new Error('store down');
                return increment(tokenId, userId, window);
            });
        } else {
            vi.spyOn(h.store, 'accountCount').mockRejectedValue(new Error('store down'));
        }
        const { token, userId } = await h.hostToken();
        const res = await request(h.server).get('/v1/rates').set(auth(token));
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internal server error' });
        vi.restoreAllMocks();
        expect(await h.store.accountCount(userId, day(h))).toBe(0);
        expect(await h.store.accountCount(userId, minute(h))).toBe(0);
    });

    it('a refused request has no caller (429, no API access, store failure)', async () => {
        let limit = 1;
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: limit, requestsPerMinute: null })));
        const seen: Array<{ status: number; caller: unknown }> = [];
        h.cli.app.get(
            '/v1/captured',
            (req, res, next) => {
                res.on('finish', () => seen.push({ status: res.statusCode, caller: req.qcliCaller }));
                next();
            },
            h.api.guard('rates:read'),
            (_req, res) => res.json({ ok: true }),
        );
        const { token } = await h.hostToken();
        await request(h.server).get('/v1/captured').set(auth(token)); // 200
        await request(h.server).get('/v1/captured').set(auth(token)); // 429
        limit = 0;
        await request(h.server).get('/v1/captured').set(auth(token)); // 403 no API access
        limit = 5;
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(h.store, 'increment').mockRejectedValueOnce(new Error('down'));
        await request(h.server).get('/v1/captured').set(auth(token)); // 500
        expect(seen.map((s) => s.status)).toEqual([200, 429, 403, 500]);
        expect(seen[0].caller).toBeTruthy();
        expect(seen.slice(1).map((s) => s.caller)).toEqual([undefined, undefined, undefined]);
    });

    it('resolver gets the caller', async () => {
        const seen: QcliCaller[] = [];
        const h = await start((b) =>
            b.setQuota((caller) => {
                seen.push(caller);
                return { requestsPerDay: null, requestsPerMinute: null };
            }),
        );
        const { token, id, userId } = await h.hostToken();
        expect((await request(h.server).get('/v1/rates').set(auth(token))).status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({ userId, userName: 'alice', tokenId: id, audience: 'host', permissions: ['rates:read'] });
    });

    it('async resolver', async () => {
        const h = await start((b) =>
            b.setQuota(async (): Promise<PublicApiQuota> => {
                await new Promise((r) => setTimeout(r, 5));
                return { requestsPerDay: 1, requestsPerMinute: null };
            }),
        );
        const { token } = await h.hostToken();
        expect((await request(h.server).get('/v1/rates').set(auth(token))).status).toBe(200);
        expect((await request(h.server).get('/v1/rates').set(auth(token))).status).toBe(429);
    });

    it('usage on token views', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 3, requestsPerMinute: null })));
        const a = await h.hostToken();
        const b = await h.hostToken();
        for (let i = 0; i < 3; i++) {
            expect((await request(h.server).get('/v1/rates').set(auth(a.token))).status).toBe(200);
        }
        const session = (await login(h.cli.app, 'alice', 'alicepass')).token;
        const list = await request(h.server).get(`${BASE}/tokens`).set(auth(session));
        expect(list.status).toBe(200);
        const byId = new Map<string, { usage: { today: number; last30Days: number; days: { date: string; requests: number }[] } }>(
            list.body.map((v: { id: string }) => [v.id, v]),
        );
        const usageA = byId.get(a.id)!.usage;
        expect(usageA.today).toBe(3);
        expect(usageA.last30Days).toBe(3);
        expect(usageA.days).toHaveLength(30);
        expect(usageA.days[29]).toEqual({ date: '2026-11-19', requests: 3 });
        expect(usageA.days[0]).toEqual({ date: '2026-10-21', requests: 0 });
        expect(byId.get(b.id)!.usage.today).toBe(0);

        const account = await h.api.usage.account(a.userId);
        expect(account.today).toBe(3);
        expect(account.quota).toEqual({ requestsPerDay: 3, requestsPerMinute: null });
        expect(account.tokens).toHaveLength(2);
        expect(account.tokens[0]).toEqual({ tokenId: a.id, name: 'site 1', usage: usageA });
        expect(Object.keys(account)).toEqual(['today', 'quota', 'tokens']);
    });

    it('account usage reads the token days once', async () => {
        const h = await start();
        const a = await h.hostToken();
        await h.hostToken();
        await request(h.server).get('/v1/rates').set(auth(a.token));
        const reads = vi.spyOn(h.store, 'tokenDays');
        const account = await h.api.usage.account(a.userId);
        expect(account.today).toBe(1);
        expect(account.tokens.map((t) => t.usage.today)).toEqual([1, 0]);
        expect(reads).toHaveBeenCalledTimes(1);
    });

    it('usage: unknown user throws 404', async () => {
        const h = await start();
        await expect(h.api.usage.account('nobody')).rejects.toMatchObject({ status: 404, message: 'user not found' });
    });

    it('headers on handler errors', async () => {
        const h = await start((b) => b.setQuota(() => ({ requestsPerDay: 5, requestsPerMinute: null })));
        const { token } = await h.hostToken();
        const res = await request(h.server).get('/v1/missing').set(auth(token));
        expect(res.status).toBe(404);
        expect(res.headers['x-ratelimit-limit']).toBe('5');
        expect(res.headers['x-ratelimit-remaining']).toBe('4');
        expect(res.headers['x-ratelimit-reset']).toBe('30');
    });

    it('setUsers is required', () => {
        expect(() => new CliPublicApiBuilder().build()).toThrow('public-api: setUsers(usersPlugin) is required');
    });

    it('the plugin result', async () => {
        const h = await start();
        expect(h.api.prefix).toBe('/qcli/api');
        expect(h.api.cliRoutes).toBe(false);
        expect(h.api.portalSection).toEqual({ kind: 'api', title: 'API reference', basePath: '/qcli/api' });
        expect(h.cli.builder.installedPlugins.map((p) => p.id)).toContain('@qodalis/cli-server-plugin-public-api');
    });
});

describe('InMemoryPublicApiUsageStore', () => {
    it('counts per token, sums per account, compensates and prunes', async () => {
        const store = new InMemoryPublicApiUsageStore();
        expect(await store.increment('t1', 'u1', '2026-11-19')).toBe(1);
        expect(await store.increment('t1', 'u1', '2026-11-19')).toBe(2);
        await store.increment('t2', 'u1', '2026-11-19');
        await store.increment('t3', 'u2', '2026-11-19');
        await store.increment('t1', 'u1', '2026-11-18');
        await store.increment('t1', 'u1', '2026-11-19T23:59');
        expect(await store.accountCount('u1', '2026-11-19')).toBe(3);
        await store.decrement('t2', '2026-11-19');
        expect(await store.accountCount('u1', '2026-11-19')).toBe(2);
        expect(await store.tokenDays(['t1', 't9'], '2026-11-19', '2026-11-19')).toEqual({ t1: { '2026-11-19': 2 } });
        await store.prune('2026-11-19', '2026-11-20T00:00');
        expect(await store.accountCount('u1', '2026-11-18')).toBe(0);
        expect(await store.accountCount('u1', '2026-11-19T23:59')).toBe(0);
        expect(await store.accountCount('u1', '2026-11-19')).toBe(2);
    });
});
