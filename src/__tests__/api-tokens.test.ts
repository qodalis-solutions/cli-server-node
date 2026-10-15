/**
 * API tokens (users plugin): create/list/revoke, scope, expiry, limits,
 * session-only creation, token authentication and lifecycle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliEchoCommandProcessor } from '../processors/cli-echo-command-processor';
import { CliUsersBuilder, UsersPluginResult, hashToken } from '../../plugins/users/index';
import { BASE, ROOT_PASS, auth, createGroup, createTestServer, createUser, login } from './users-test-helpers';

const DAY = 24 * 60 * 60 * 1000;

async function createToken(app: any, token: string, body: Record<string, unknown>) {
    return request(app).post(`${BASE}/tokens`).set(auth(token)).send(body);
}

describe('API tokens: create', () => {
    it('creates a token: 201 { token, apiToken } with a qcli_pat_ token and a view without secrets', async () => {
        const { app, plugin } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        const before = Date.now();
        const res = await createToken(app, root.token, { name: 'ci' });
        expect(res.status).toBe(201);
        expect(res.body.token).toMatch(/^qcli_pat_[A-Za-z0-9_-]{43}$/);
        const view = res.body.apiToken;
        expect(view).toMatchObject({ name: 'ci', userId: root.userId, userName: 'root', lastUsedAt: null });
        expect(typeof view.id).toBe('string');
        expect(view.id).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(view.permissions ?? null).toBeNull();
        expect(view.tokenHash).toBeUndefined();
        expect(view.token).toBeUndefined();
        // default expiry: 90 days
        expect(view.expiresAt).toBeGreaterThanOrEqual(before + 90 * DAY);
        expect(view.expiresAt).toBeLessThanOrEqual(Date.now() + 90 * DAY);
        // only the hash is stored
        const stored = await plugin.apiTokenStore.getToken(view.id);
        expect(stored!.tokenHash).toBe(hashToken(res.body.token));
        expect(JSON.stringify(stored)).not.toContain(res.body.token);
    });

    it('validates the name (400) and rejects duplicates case-insensitively (409)', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        for (const name of ['', 'x'.repeat(65), 'bad/name', 'emoji😀', 12, undefined]) {
            const res = await createToken(app, root.token, { name });
            expect(res.status, String(name)).toBe(400);
        }
        expect((await createToken(app, root.token, { name: 'My token-1.x_y' })).status).toBe(201);
        const dup = await createToken(app, root.token, { name: 'my TOKEN-1.x_y' });
        expect(dup.status).toBe(409);
        expect(dup.body.error).toBeDefined();
    });

    it('expiresInDays: integer 1-365; null only with allowNonExpiringTokens', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        for (const expiresInDays of [0, 366, 1.5, '30', -1]) {
            expect((await createToken(app, root.token, { name: `t${expiresInDays}`, expiresInDays })).status).toBe(400);
        }
        const one = await createToken(app, root.token, { name: 'one', expiresInDays: 1 });
        expect(one.status).toBe(201);
        expect(one.body.apiToken.expiresAt - one.body.apiToken.createdAt).toBe(DAY);
        expect((await createToken(app, root.token, { name: 'max', expiresInDays: 365 })).status).toBe(201);
        expect((await createToken(app, root.token, { name: 'never', expiresInDays: null })).status).toBe(400);

        const allowed = await createTestServer({ allowNonExpiringTokens: true });
        const r2 = await login(allowed.app, 'root', ROOT_PASS);
        const never = await createToken(allowed.app, r2.token, { name: 'never', expiresInDays: null });
        expect(never.status).toBe(201);
        expect(never.body.apiToken.expiresAt).toBeNull();
        const res = await request(allowed.app).get(`${BASE}/sessions/ws-ticket`).set(auth(never.body.token));
        expect(res.status).not.toBe(401);
    });

    it('scope: valid entries covered by the caller (403 cannot grant), invalid → 400', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        await createUser(app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw' });
        const alice = await login(app, 'alice', 'alicepw');

        const ok = await createToken(app, alice.token, { name: 'scoped', permissions: ['commands:execute'] });
        expect(ok.status).toBe(201);
        expect(ok.body.apiToken.permissions).toEqual(['commands:execute']);

        const denied = await createToken(app, alice.token, { name: 'x', permissions: ['commands:execute', 'users:read'] });
        expect(denied.status).toBe(403);
        expect(denied.body.error).toBe('forbidden: cannot grant users:read');

        expect((await createToken(app, alice.token, { name: 'y', permissions: ['bad perm'] })).status).toBe(400);
        expect((await createToken(app, alice.token, { name: 'z', permissions: 'commands:execute' })).status).toBe(400);
        // root ('*') may grant anything, wildcards included
        expect((await createToken(app, root.token, { name: 'w', permissions: ['users:*'] })).status).toBe(201);
    });

    it('at most 20 tokens per user (400)', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        for (let i = 0; i < 20; i++) {
            expect((await createToken(app, root.token, { name: `t${i}` })).status).toBe(201);
        }
        const res = await createToken(app, root.token, { name: 't20' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/20/);
    });

    it('requires a session: a request authenticated by an API token gets 403', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        const { body } = await createToken(app, root.token, { name: 'ci' });
        const res = await createToken(app, body.token, { name: 'minted' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('forbidden: API tokens cannot create tokens');
    });

    it('requires authentication (401)', async () => {
        const { app } = await createTestServer();
        expect((await request(app).post(`${BASE}/tokens`).send({ name: 'x' })).status).toBe(401);
        expect((await request(app).get(`${BASE}/tokens`)).status).toBe(401);
    });

    it('audits token_created and token_revoked with name and id', async () => {
        const { app, plugin } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        const { body } = await createToken(app, root.token, { name: 'ci' });
        await request(app).delete(`${BASE}/tokens/${body.apiToken.id}`).set(auth(root.token)).expect(204);
        const entries = await plugin.auditStore.getEntries();
        const created = entries.find((e) => e.event === 'token_created')!;
        const revoked = entries.find((e) => e.event === 'token_revoked')!;
        for (const e of [created, revoked]) {
            expect(e.details).toContain('ci');
            expect(e.details).toContain(body.apiToken.id);
            expect(e.actor).toBe('root');
            expect(JSON.stringify(e)).not.toContain(body.token);
        }
    });
});

describe('API tokens: list and revoke', () => {
    it('lists own tokens; ?all=true requires tokens:read', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        await createUser(app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw' });
        const alice = await login(app, 'alice', 'alicepw');
        await createToken(app, root.token, { name: 'root-1' });
        await createToken(app, alice.token, { name: 'alice-1' });

        const own = await request(app).get(`${BASE}/tokens`).set(auth(alice.token));
        expect(own.status).toBe(200);
        expect(own.body.map((t: any) => t.name)).toEqual(['alice-1']);
        expect(own.body[0]).toMatchObject({ userName: 'alice', lastUsedAt: null });
        expect(own.body[0].tokenHash).toBeUndefined();

        expect((await request(app).get(`${BASE}/tokens?all=true`).set(auth(alice.token))).status).toBe(403);

        const all = await request(app).get(`${BASE}/tokens?all=true`).set(auth(root.token));
        expect(all.status).toBe(200);
        expect(all.body.map((t: any) => `${t.userName}:${t.name}`).sort()).toEqual(['alice:alice-1', 'root:root-1']);

        // tokens:read through a group
        await createGroup(app, root.token, { name: 'auditors', permissions: ['tokens:read'] });
        await request(app).post(`${BASE}/groups/auditors/members/alice`).set(auth(root.token)).expect(204);
        const viaGroup = await request(app).get(`${BASE}/tokens?all=true`).set(auth(alice.token));
        expect(viaGroup.status).toBe(200);
        expect(viaGroup.body).toHaveLength(2);
    });

    it('revoke: owner 204; another user without tokens:revoke 404; with tokens:revoke 204; unknown 404', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        await createUser(app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw' });
        await createUser(app, root.token, { name: 'bob', email: 'b@example.com', password: 'bobpw1' });
        const alice = await login(app, 'alice', 'alicepw');
        const bob = await login(app, 'bob', 'bobpw1');
        const a1 = (await createToken(app, alice.token, { name: 'a1' })).body;
        const a2 = (await createToken(app, alice.token, { name: 'a2' })).body;

        expect((await request(app).delete(`${BASE}/tokens/${a1.apiToken.id}`).set(auth(bob.token))).status).toBe(404);
        expect((await request(app).delete(`${BASE}/tokens/nope`).set(auth(alice.token))).status).toBe(404);
        expect((await request(app).delete(`${BASE}/tokens/${a1.apiToken.id}`).set(auth(alice.token))).status).toBe(204);
        expect((await request(app).delete(`${BASE}/tokens/${a2.apiToken.id}`).set(auth(root.token))).status).toBe(204);
        expect((await request(app).get(`${BASE}/tokens`).set(auth(alice.token))).body).toEqual([]);
        // revoked tokens no longer authenticate
        expect((await request(app).get(`${BASE}/tokens`).set(auth(a1.token))).status).toBe(401);
    });

    it('an API token may list and revoke its own user tokens', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        const t = (await createToken(app, root.token, { name: 'ci' })).body;
        const list = await request(app).get(`${BASE}/tokens`).set(auth(t.token));
        expect(list.status).toBe(200);
        expect(list.body[0].lastUsedAt).toEqual(expect.any(Number));
        expect((await request(app).delete(`${BASE}/tokens/${t.apiToken.id}`).set(auth(t.token))).status).toBe(204);
        expect((await request(app).get(`${BASE}/tokens`).set(auth(t.token))).status).toBe(401);
    });
});

describe('API tokens: authentication', () => {
    it('effective permissions: the scope entries the user still holds', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        await createGroup(app, root.token, { name: 'readers', permissions: ['users:read', 'commands:execute'] });
        await createUser(app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw', groups: ['readers'] });
        const alice = await login(app, 'alice', 'alicepw');
        const scoped = (await createToken(app, alice.token, { name: 's', permissions: ['commands:execute'] })).body;
        const full = (await createToken(app, alice.token, { name: 'f' })).body;

        // scoped token lacks users:read
        expect((await request(app).get(`${BASE}/users`).set(auth(scoped.token))).status).toBe(403);
        expect((await request(app).get(`${BASE}/users`).set(auth(full.token))).status).toBe(200);
        const perms = await request(app).get(`${BASE}/users/alice/permissions`).set(auth(full.token));
        expect(perms.status).toBe(200);

        // user loses users:read → the unscoped token loses it too (live permissions)
        await request(app).put(`${BASE}/groups/readers`).set(auth(root.token)).send({ permissions: ['commands:execute'] }).expect(200);
        expect((await request(app).get(`${BASE}/users`).set(auth(full.token))).status).toBe(403);
    });

    it('scope entries the user no longer holds are dropped', async () => {
        const { app, plugin } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        await createGroup(app, root.token, { name: 'readers', permissions: ['users:read'] });
        await createUser(app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw', groups: ['readers'] });
        const alice = await login(app, 'alice', 'alicepw');
        const scoped = (await createToken(app, alice.token, { name: 's', permissions: ['users:read'] })).body;
        const ctx = await plugin.authService.authenticateToken(scoped.token);
        expect(ctx.permissions).toEqual(['users:read']);
        await request(app).put(`${BASE}/groups/readers`).set(auth(root.token)).send({ permissions: [] }).expect(200);
        const after = await plugin.authService.authenticateToken(scoped.token);
        expect(after.permissions).toEqual([]);
        expect(after.apiToken?.id).toBe(scoped.apiToken.id);
        expect(after.session).toBeUndefined();
    });

    it('unknown, expired and revoked tokens → 401; disabled user → 401; re-enabled → works', async () => {
        const { app, plugin } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        await createUser(app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw' });
        const alice = await login(app, 'alice', 'alicepw');
        const t = (await createToken(app, alice.token, { name: 't', expiresInDays: 1 })).body;

        expect((await request(app).get(`${BASE}/tokens`).set(auth('qcli_pat_unknown'))).status).toBe(401);
        expect((await request(app).get(`${BASE}/tokens`).set(auth(t.token))).status).toBe(200);

        await request(app).put(`${BASE}/users/alice`).set(auth(root.token)).send({ disabled: true }).expect(200);
        expect((await request(app).get(`${BASE}/tokens`).set(auth(t.token))).status).toBe(401);
        await request(app).put(`${BASE}/users/alice`).set(auth(root.token)).send({ disabled: false }).expect(200);
        expect((await request(app).get(`${BASE}/tokens`).set(auth(t.token))).status).toBe(200);
        // disabling does not delete tokens
        expect(await plugin.apiTokenStore.getTokens(alice.userId)).toHaveLength(1);

        const now = Date.now();
        const spy = vi.spyOn(Date, 'now').mockReturnValue(now + DAY + 1000);
        try {
            expect((await request(app).get(`${BASE}/users/alice`).set(auth(t.token))).status).toBe(401);
        } finally {
            spy.mockRestore();
        }
    });

    it('lastUsedAt is written at most once per 60 s', async () => {
        const { app, plugin } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        const t = (await createToken(app, root.token, { name: 't' })).body;
        const spy = vi.spyOn(plugin.apiTokenStore, 'updateLastUsed');
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            await plugin.authService.authenticateToken(t.token);
            await plugin.authService.authenticateToken(t.token);
            clock.mockReturnValue(now + 30_000);
            await plugin.authService.authenticateToken(t.token);
            expect(spy).toHaveBeenCalledTimes(1);
            clock.mockReturnValue(now + 61_000);
            await plugin.authService.authenticateToken(t.token);
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            clock.mockRestore();
        }
        expect((await plugin.apiTokenStore.getToken(t.apiToken.id))!.lastUsedAt).toBe(now + 61_000);
    });

    it('mustChangePassword: token requests get the same 403 as sessions', async () => {
        const { app, plugin } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        const t = (await createToken(app, root.token, { name: 't' })).body;
        await plugin.userStore.updateUser(root.userId, { mustChangePassword: true });
        const res = await request(app).get(`${BASE}/tokens`).set(auth(t.token));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('password change required');
    });

    it('sessions/current with a token → 404 "not a session"; password change → 403', async () => {
        const { app } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        const t = (await createToken(app, root.token, { name: 't' })).body;
        const get = await request(app).get(`${BASE}/sessions/current`).set(auth(t.token));
        expect(get.status).toBe(404);
        expect(get.body.error).toBe('not a session');
        expect((await request(app).delete(`${BASE}/sessions/current`).set(auth(t.token))).status).toBe(404);
        const pw = await request(app)
            .put(`${BASE}/users/root/password`)
            .set(auth(t.token))
            .send({ password: 'newpass12', currentPassword: ROOT_PASS });
        expect(pw.status).toBe(403);
        expect(pw.body.error).toBe('forbidden: API tokens cannot change passwords');
        // the session still works and the password did not change
        await login(app, 'root', ROOT_PASS);
    });

    it('deleting a user deletes their tokens', async () => {
        const { app, plugin } = await createTestServer();
        const root = await login(app, 'root', ROOT_PASS);
        const id = await createUser(app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw' });
        const alice = await login(app, 'alice', 'alicepw');
        const t = (await createToken(app, alice.token, { name: 't' })).body;
        await request(app).delete(`${BASE}/users/alice`).set(auth(root.token)).expect(204);
        expect(await plugin.apiTokenStore.getTokens(id)).toEqual([]);
        expect((await request(app).get(`${BASE}/tokens`).set(auth(t.token))).status).toBe(401);
    });
});

// ---------------------------------------------------------------- server

interface Harness {
    cli: CliServerResult;
    users: UsersPluginResult;
    server: http.Server;
    port: number;
}

let current: Harness | undefined;

afterEach(async () => {
    const h = current;
    current = undefined;
    if (!h) return;
    h.cli.eventSocketManager.dispose();
    h.cli.logSocketManager.dispose();
    h.users.dispose();
    await new Promise<void>((r) => h.server.close(() => r()));
});

async function startServer(): Promise<Harness> {
    const cli = createCliServer({
        allowedOrigins: ['http://localhost:4300'],
        configure: (b) => b.addProcessor(new CliEchoCommandProcessor()),
    });
    const users = new CliUsersBuilder()
        .setDefaultAdminPassword(ROOT_PASS)
        .setIpRateLimit(10_000)
        .setMinPasswordLength(4)
        .build((msg) => cli.eventSocketManager.broadcastMessage(msg));
    await users.ready;
    cli.mountPlugin(users);
    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(server);
    cli.logSocketManager.attach(server);
    current = { cli, users, server, port: (server.address() as AddressInfo).port };
    return current;
}

function openSocket(port: number, path: string): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        const closed = new Promise<{ code: number; reason: string }>((r) =>
            ws.on('close', (code, reason) => r({ code, reason: reason.toString() })),
        );
        ws.on('open', () => resolve({ ws, closed }));
        ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)));
        ws.on('error', () => undefined);
    });
}

const within = <T>(p: Promise<T>, ms = 3000): Promise<T | 'open'> =>
    Promise.race([p, new Promise<'open'>((r) => setTimeout(() => r('open'), ms))]);

describe('API tokens on the protected server', () => {
    it('authenticates server routes (/execute) like a session; scope applies', async () => {
        const h = await startServer();
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        const full = (await createToken(h.cli.app, root.token, { name: 'full' })).body;
        const noExec = (await createToken(h.cli.app, root.token, { name: 'ro', permissions: ['users:read'] })).body;

        const ok = await request(h.cli.app).post('/api/qcli/execute').set(auth(full.token)).send({ command: 'echo', value: 'hi', chainCommands: [], args: {}, rawCommand: 'echo hi' });
        expect(ok.status).toBe(200);
        expect(ok.body.exitCode).toBe(0);

        const denied = await request(h.cli.app).post('/api/qcli/execute').set(auth(noExec.token)).send({ command: 'echo', value: 'hi', chainCommands: [], args: {} });
        expect(denied.status).toBe(403);
        expect((await request(h.cli.app).post('/api/qcli/execute').set(auth('qcli_pat_nope')).send({ command: 'echo' })).status).toBe(401);
    });

    it('serverAuth context carries tokenId (no sessionId)', async () => {
        const h = await startServer();
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        const t = (await createToken(h.cli.app, root.token, { name: 't' })).body;
        const req = { headers: { authorization: `Bearer ${t.token}` }, method: 'GET' } as any;
        const ctx = await h.users.serverAuth.authenticateRequest(req);
        expect(ctx.tokenId).toBe(t.apiToken.id);
        expect(ctx.sessionId).toBeUndefined();
    });

    it('sockets opened with a token identity close with 4401 when the token is revoked', async () => {
        const h = await startServer();
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        const t = (await createToken(h.cli.app, root.token, { name: 't' })).body;
        const other = (await createToken(h.cli.app, root.token, { name: 'other' })).body;
        const ticket = async (token: string) =>
            (await request(h.cli.app).post(`${BASE}/sessions/ws-ticket`).set(auth(token)).expect(201)).body.ticket;

        const events = await openSocket(h.port, `/ws/v1/qcli/events?ticket=${await ticket(t.token)}`);
        const logs = await openSocket(h.port, `/ws/v1/qcli/logs?ticket=${await ticket(t.token)}`);
        const survivor = await openSocket(h.port, `/ws/v1/qcli/events?ticket=${await ticket(other.token)}`);

        await request(h.cli.app).delete(`${BASE}/tokens/${t.apiToken.id}`).set(auth(root.token)).expect(204);

        expect(await within(events.closed)).toEqual({ code: 4401, reason: 'session ended' });
        expect(await within(logs.closed)).toEqual({ code: 4401, reason: 'session ended' });
        expect(survivor.ws.readyState).toBe(WebSocket.OPEN);
        survivor.ws.close();
    });

    it('sockets opened with a token identity close with 4401 when the user is disabled', async () => {
        const h = await startServer();
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        await createUser(h.cli.app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw' });
        const alice = await login(h.cli.app, 'alice', 'alicepw');
        const t = (await createToken(h.cli.app, alice.token, { name: 't' })).body;
        const tk = (await request(h.cli.app).post(`${BASE}/sessions/ws-ticket`).set(auth(t.token)).expect(201)).body.ticket;
        const events = await openSocket(h.port, `/ws/v1/qcli/events?ticket=${tk}`);
        await request(h.cli.app).put(`${BASE}/users/alice`).set(auth(root.token)).send({ disabled: true }).expect(200);
        expect(await within(events.closed)).toEqual({ code: 4401, reason: 'session ended' });
    });
});
