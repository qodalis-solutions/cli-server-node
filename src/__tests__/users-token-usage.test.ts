/**
 * `usage` on token views: added (last) only when a usage provider is registered
 * (the public-api plugin registers one); a provider failure keeps the list.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { ApiTokenUsage } from '../../plugins/users/index';
import { BASE, ROOT_PASS, TestServer, auth, createTestServer, login } from './users-test-helpers';

const servers: TestServer[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    while (servers.length) servers.pop()!.plugin.dispose();
});

async function start(): Promise<{ s: TestServer; rootToken: string; aliceToken: string; aliceId: string }> {
    const s = await createTestServer();
    servers.push(s);
    const rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
    const alice = await s.plugin.userStore.createUser({ name: 'alice', email: 'alice@example.com', groups: ['users'] });
    await s.plugin.authService.setPassword(alice.id, 'alicepass');
    const aliceToken = (await login(s.app, 'alice', 'alicepass')).token;
    return { s, rootToken, aliceToken, aliceId: alice.id };
}

async function createToken(s: TestServer, session: string, name: string): Promise<string> {
    const res = await request(s.app).post(`${BASE}/tokens`).set(auth(session)).send({ name });
    expect(res.status).toBe(201);
    expect(res.body.apiToken).not.toHaveProperty('usage');
    return res.body.apiToken.id;
}

function usageOf(seed: number): ApiTokenUsage {
    const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, requests: i + seed }));
    const last30Days = days.reduce((sum, d) => sum + d.requests, 0);
    return { today: days[29].requests, last30Days, days };
}

describe('token usage on token views', () => {
    it('no provider, no usage key', async () => {
        const { s, aliceToken } = await start();
        await createToken(s, aliceToken, 'one');
        const res = await request(s.app).get(`${BASE}/tokens`).set(auth(aliceToken));
        expect(res.status).toBe(200);
        expect(Object.keys(res.body[0])).toEqual(['id', 'name', 'userId', 'userName', 'createdAt', 'expiresAt', 'lastUsedAt', 'audience']);
    });

    it('provider adds usage last', async () => {
        const { s, aliceToken } = await start();
        const id = await createToken(s, aliceToken, 'one');
        s.plugin.setTokenUsageProvider(async (ids) => Object.fromEntries(ids.map((i) => [i, usageOf(0)])));
        const res = await request(s.app).get(`${BASE}/tokens`).set(auth(aliceToken));
        expect(res.status).toBe(200);
        const view = res.body[0];
        expect(view.id).toBe(id);
        expect(Object.keys(view).at(-1)).toBe('usage');
        expect(view.usage.today).toBe(29);
        expect(view.usage.last30Days).toBe(435);
        expect(view.usage.days).toHaveLength(30);
        expect(view.usage.days[0]).toEqual({ date: '2026-10-01', requests: 0 });
    });

    it('usage comes after permissions', async () => {
        const { s, aliceToken } = await start();
        const res = await request(s.app)
            .post(`${BASE}/tokens`)
            .set(auth(aliceToken))
            .send({ name: 'scoped', permissions: ['commands:execute'] });
        expect(res.status).toBe(201);
        s.plugin.setTokenUsageProvider(async (ids) => Object.fromEntries(ids.map((i) => [i, usageOf(1)])));
        const list = await request(s.app).get(`${BASE}/tokens`).set(auth(aliceToken));
        expect(Object.keys(list.body[0]).slice(-2)).toEqual(['permissions', 'usage']);
    });

    it('?all=true calls the provider once with every id', async () => {
        const { s, rootToken, aliceToken } = await start();
        const a = await createToken(s, aliceToken, 'alice-token');
        const r = await createToken(s, rootToken, 'root-token');
        const provider = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((i) => [i, usageOf(0)])));
        s.plugin.setTokenUsageProvider(provider);
        const res = await request(s.app).get(`${BASE}/tokens?all=true`).set(auth(rootToken));
        expect(res.status).toBe(200);
        expect(provider).toHaveBeenCalledTimes(1);
        expect([...provider.mock.calls[0][0]].sort()).toEqual([a, r].sort());
        expect(res.body.every((v: { usage?: unknown }) => v.usage)).toBe(true);
    });

    it('provider failure keeps the list', async () => {
        const { s, aliceToken } = await start();
        await createToken(s, aliceToken, 'one');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        s.plugin.setTokenUsageProvider(async () => {
            throw new Error('usage store down');
        });
        const res = await request(s.app).get(`${BASE}/tokens`).set(auth(aliceToken));
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).not.toHaveProperty('usage');
        expect(errors).toHaveBeenCalledTimes(1);
    });

    it('apiTokens.list has usage, POST /tokens has none', async () => {
        const { s, aliceToken, aliceId } = await start();
        s.plugin.setTokenUsageProvider(async (ids) => Object.fromEntries(ids.map((i) => [i, usageOf(2)])));
        await createToken(s, aliceToken, 'one');
        const created = await s.plugin.apiTokens.create(aliceId, { name: 'two' });
        expect(created.apiToken).not.toHaveProperty('usage');
        const views = await s.plugin.apiTokens.list(aliceId);
        expect(views).toHaveLength(2);
        expect(views.every((v) => v.usage?.today === 31)).toBe(true);
    });

    it('setTokenUsageProvider(null) removes the provider', async () => {
        const { s, aliceToken } = await start();
        await createToken(s, aliceToken, 'one');
        s.plugin.setTokenUsageProvider(async (ids) => Object.fromEntries(ids.map((i) => [i, usageOf(0)])));
        s.plugin.setTokenUsageProvider(null);
        const res = await request(s.app).get(`${BASE}/tokens`).set(auth(aliceToken));
        expect(res.body[0]).not.toHaveProperty('usage');
    });
});
