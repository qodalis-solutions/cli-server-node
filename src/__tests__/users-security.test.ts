/**
 * Appendix B — users plugin security: escalation (B3), default credentials and
 * password policy (B4), brute force / DoS (B5), token hashing (B6), input
 * validation (B7), audit (B8) and CSRF (B9).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express, { Request } from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import { CliUsersBuilder, User, AuthAdapter } from '../../plugins/users/index';
import { BASE, ROOT_PASS, TestServer, auth, createTestServer, createUser, createGroup, login } from './users-test-helpers';

// ---------------------------------------------------------------------------
// B3 — no privilege escalation
// ---------------------------------------------------------------------------

describe('B3: privilege escalation', () => {
    let s: TestServer;
    let root: string;
    let helper: string;

    beforeAll(async () => {
        s = await createTestServer();
        root = (await login(s.app, 'root', ROOT_PASS)).token;
        // a delegated administrator: manages users, groups and sessions, but is not '*'
        await createGroup(s.app, root, {
            name: 'helpdesk',
            permissions: ['users:*', 'groups:*', 'sessions:*', 'commands:execute'],
        });
        await createGroup(s.app, root, { name: 'auditors', permissions: ['audit:read'] });
        await createUser(s.app, root, { name: 'helper', email: 'helper@x.io', password: 'helppass', groups: ['helpdesk'] });
        await createUser(s.app, root, { name: 'joe', email: 'joe@x.io', password: 'joepass1' });
        helper = (await login(s.app, 'helper', 'helppass')).token;
    });
    afterAll(() => s.plugin.dispose());

    const h = () => ({
        post: (p: string, b: object = {}) => request(s.app).post(`${BASE}${p}`).set(auth(helper)).send(b),
        put: (p: string, b: object = {}) => request(s.app).put(`${BASE}${p}`).set(auth(helper)).send(b),
        del: (p: string) => request(s.app).delete(`${BASE}${p}`).set(auth(helper)),
    });

    it('cannot create or update a group with permissions it does not hold', async () => {
        const res = await h().post('/groups', { name: 'evil', permissions: ['*'] });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'cannot grant permissions you do not hold: *' });
        const partial = await h().post('/groups', { name: 'evil', permissions: ['users:read', 'audit:clear', 'logs:read'] });
        expect(partial.status).toBe(403);
        expect(partial.body.error).toBe('cannot grant permissions you do not hold: audit:clear, logs:read');
        expect((await h().post('/groups', { name: 'ok', permissions: ['users:read', 'sessions:revoke'] })).status).toBe(201);
        expect((await h().put('/groups/ok', { permissions: ['shell:execute'] })).status).toBe(403);
        expect((await h().put('/groups/users', { permissions: ['commands:execute', 'files:*'] })).status).toBe(403);
    });

    it('cannot add users to groups granting more than it holds', async () => {
        expect((await h().post('/groups/admin/members/joe')).status).toBe(403);
        expect((await h().post('/groups/auditors/members/joe')).status).toBe(403);
        expect((await h().post('/groups/admin/members/helper')).status).toBe(403); // not even itself
        expect((await h().put('/users/joe', { groups: ['users', 'admin'] })).status).toBe(403);
        expect((await h().post('/users', { name: 'x1', email: 'x1@x.io', groups: ['admin'] })).status).toBe(403);
        expect((await h().post('/users', { name: 'x2', email: 'x2@x.io', groups: ['helpdesk'] })).status).toBe(201);
    });

    it('cannot act on a user with more privileges', async () => {
        const rootSession = await login(s.app, 'root', ROOT_PASS);
        const cases = [
            await h().put('/users/root', { name: 'pwned' }),
            await h().put('/users/root', { disabled: true }),
            await h().put('/users/root', { groups: ['users'] }),
            await h().put('/users/root/password', { password: 'hijacked1' }),
            await h().del('/users/root'),
            await h().del('/groups/admin/members/root'),
            await h().del(`/sessions/${rootSession.sessionId}`),
            await h().post('/users/root/verify-password', { password: ROOT_PASS }),
        ];
        for (const res of cases) {
            expect(res.status, `${res.req.method} ${res.req.path}`).toBe(403);
            expect(res.body).toEqual({ error: 'insufficient privileges for this user' });
        }
        // a peer with equal permissions is fine
        expect((await h().put('/users/joe', { disabled: true })).status).toBe(200);
        expect((await h().put('/users/joe', { disabled: false })).status).toBe(200);
        expect((await h().put('/users/joe/password', { password: 'newjoe12' })).status).toBe(204);
    });
});

// ---------------------------------------------------------------------------
// B4 — default credentials, mustChangePassword, password policy
// ---------------------------------------------------------------------------

describe('B4: default credentials and password policy', () => {
    it('generates a random root password, logs it once, and forces a change', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const plugin = new CliUsersBuilder().build();
        await plugin.ready;
        const messages = warn.mock.calls.map((c) => String(c[0]));
        warn.mockRestore();
        const line = messages.find((m) => m.includes('Generated password'));
        expect(line).toBeDefined();
        const password = /root": (\S{16}) /.exec(line!)![1];
        expect(password).toHaveLength(16);
        expect(messages.filter((m) => m.includes(password))).toHaveLength(1);

        const app = express();
        app.use(plugin.prefix, plugin.router);
        const loginRes = await request(app).post(`${BASE}/sessions`).send({ username: 'root', password });
        expect(loginRes.status).toBe(201);
        expect(loginRes.body.session.user.mustChangePassword).toBe(true);
        const token = loginRes.body.token;

        // only the current session and the own password change are allowed
        expect((await request(app).get(`${BASE}/sessions/current`).set(auth(token))).status).toBe(200);
        for (const res of [
            await request(app).get(`${BASE}/users`).set(auth(token)),
            await request(app).get(`${BASE}/groups`).set(auth(token)),
            await request(app).post(`${BASE}/sessions/ws-ticket`).set(auth(token)),
            await request(app).get(`${BASE}/audit`).set(auth(token)),
        ]) {
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ error: 'password change required' });
        }
        expect((await request(app).put(`${BASE}/users/root/password`).set(auth(token)).send({ password: 'short' })).status).toBe(400);
        expect((await request(app).put(`${BASE}/users/root/password`).set(auth(token)).send({ password: 'a-new-strong-pass' })).status).toBe(204);
        const after = await request(app).get(`${BASE}/sessions/current`).set(auth(token));
        expect(after.body.user.mustChangePassword).toBe(false);
        expect((await request(app).get(`${BASE}/users`).set(auth(token))).status).toBe(200);
        plugin.dispose();
    });

    it('explicit weak defaultAdminPassword: no flag, but a warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const plugin = new CliUsersBuilder().setDefaultAdminPassword('admin').build();
        await plugin.ready;
        const messages = warn.mock.calls.map((c) => String(c[0]));
        warn.mockRestore();
        expect(messages.some((m) => m.includes('well-known default password'))).toBe(true);
        expect((await plugin.userStore.getUser('root'))!.mustChangePassword).toBe(false);
        plugin.dispose();
    });

    it('admin reset makes the password temporary unless temporary:false', async () => {
        const s = await createTestServer();
        const root = (await login(s.app, 'root', ROOT_PASS)).token;
        await createUser(s.app, root, { name: 'ann', email: 'ann@x.io', password: 'annpass1' });
        const fresh = await request(s.app).get(`${BASE}/users/ann`).set(auth(root));
        expect(fresh.body.mustChangePassword).toBe(false);

        await request(s.app).put(`${BASE}/users/ann/password`).set(auth(root)).send({ password: 'temp-pass' }).expect(204);
        expect((await request(s.app).get(`${BASE}/users/ann`).set(auth(root))).body.mustChangePassword).toBe(true);
        const ann = await login(s.app, 'ann', 'temp-pass');
        expect((await request(s.app).get(`${BASE}/groups`).set(auth(ann.token))).status).toBe(403);
        // cannot change someone else's password meanwhile
        expect((await request(s.app).put(`${BASE}/users/root/password`).set(auth(ann.token)).send({ password: 'whatever1' })).status).toBe(403);
        await request(s.app).put(`${BASE}/users/ann/password`).set(auth(ann.token)).send({ password: 'mine-now', currentPassword: 'temp-pass' }).expect(204);
        expect((await request(s.app).get(`${BASE}/groups`).set(auth(ann.token))).status).toBe(200);

        await request(s.app).put(`${BASE}/users/ann/password`).set(auth(root)).send({ password: 'final-pass', temporary: false }).expect(204);
        expect((await request(s.app).get(`${BASE}/users/ann`).set(auth(root))).body.mustChangePassword).toBe(false);
        s.plugin.dispose();
    });

    it('enforces min length 8 by default and max 1024', async () => {
        const s = await createTestServer({ minPasswordLength: undefined });
        const root = (await login(s.app, 'root', ROOT_PASS)).token;
        const short = await request(s.app).post(`${BASE}/users`).set(auth(root)).send({ name: 'p1', email: 'p1@x.io', password: '1234567' });
        expect(short.status).toBe(400);
        expect(short.body.error).toMatch(/at least 8/);
        const long = await request(s.app).post(`${BASE}/users`).set(auth(root)).send({ name: 'p2', email: 'p2@x.io', password: 'x'.repeat(1025) });
        expect(long.status).toBe(400);
        expect(long.body.error).toMatch(/at most 1024/);
        expect((await request(s.app).post(`${BASE}/users`).set(auth(root)).send({ name: 'p3', email: 'p3@x.io', password: '12345678' })).status).toBe(201);
        s.plugin.dispose();
    });

    it('mustChangePassword is always present in user JSON', async () => {
        const s = await createTestServer();
        const root = (await login(s.app, 'root', ROOT_PASS)).token;
        const list = await request(s.app).get(`${BASE}/users`).set(auth(root));
        expect(list.body.every((u: User) => typeof u.mustChangePassword === 'boolean')).toBe(true);
        s.plugin.dispose();
    });
});

// ---------------------------------------------------------------------------
// B5 — brute force, enumeration, DoS
// ---------------------------------------------------------------------------

describe('B5: brute force and DoS', () => {
    let s: TestServer;
    let root: string;
    beforeEach(async () => {
        s = await createTestServer();
        root = (await login(s.app, 'root', ROOT_PASS)).token;
        await createUser(s.app, root, { name: 'vic', email: 'vic@x.io', password: 'vicpass1' });
    });
    afterEach(() => s.plugin.dispose());

    it('lockout bookkeeping is atomic under concurrent requests', async () => {
        const attempts = await Promise.all(
            Array.from({ length: 20 }, () => request(s.app).post(`${BASE}/sessions`).send({ username: 'vic', password: 'wrong' })),
        );
        const statuses = attempts.map((r) => r.status);
        expect(statuses.filter((x) => x === 401)).toHaveLength(5);
        expect(statuses.filter((x) => x === 429)).toHaveLength(15);
        const audit = await request(s.app).get(`${BASE}/audit?event=login_failed&username=vic`).set(auth(root));
        expect(audit.body.filter((e: any) => e.details === 'Wrong password')).toHaveLength(5);
        // even the right password is refused while locked
        expect((await request(s.app).post(`${BASE}/sessions`).send({ username: 'vic', password: 'vicpass1' })).status).toBe(429);
    });

    it('unknown usernames are locked exactly like known ones', async () => {
        for (let i = 0; i < 5; i++) {
            expect((await request(s.app).post(`${BASE}/sessions`).send({ username: 'ghost', password: 'x' })).status).toBe(401);
        }
        const res = await request(s.app).post(`${BASE}/sessions`).send({ username: 'GHOST', password: 'x' });
        expect(res.status).toBe(429);
        expect(res.body).toEqual({ error: 'account locked, try again later' });
    });

    it('admin password reset clears the lockout', async () => {
        for (let i = 0; i < 5; i++) await request(s.app).post(`${BASE}/sessions`).send({ username: 'vic', password: 'wrong' });
        expect((await request(s.app).post(`${BASE}/sessions`).send({ username: 'vic', password: 'vicpass1' })).status).toBe(429);
        await request(s.app).put(`${BASE}/users/vic/password`).set(auth(root)).send({ password: 'vicpass2', temporary: false }).expect(204);
        expect((await request(s.app).post(`${BASE}/sessions`).send({ username: 'vic', password: 'vicpass2' })).status).toBe(201);
    });

    it('self password change goes through lockout and audit', async () => {
        const vic = await login(s.app, 'vic', 'vicpass1');
        for (let i = 0; i < 5; i++) {
            const r = await request(s.app).put(`${BASE}/users/vic/password`).set(auth(vic.token)).send({ password: 'newpass12', currentPassword: 'bad' });
            expect(r.status).toBe(403);
        }
        const locked = await request(s.app).put(`${BASE}/users/vic/password`).set(auth(vic.token)).send({ password: 'newpass12', currentPassword: 'vicpass1' });
        expect(locked.status).toBe(429);
        const audit = await request(s.app).get(`${BASE}/audit?event=login_failed&username=vic`).set(auth(root));
        expect(audit.body.length).toBeGreaterThanOrEqual(5);
        expect(audit.body[audit.body.length - 1]).toMatchObject({ actor: 'vic', actorId: vic.userId, userId: vic.userId });
    });

    it('per-IP limiter: 429 after the limit on login and verify-password', async () => {
        const limited = await createTestServer({ ipRateLimit: 3, ipRateLimitWindowMs: 60_000 });
        try {
            for (let i = 0; i < 3; i++) {
                expect((await request(limited.app).post(`${BASE}/sessions`).send({ username: 'nobody', password: 'x' })).status).toBe(401);
            }
            const res = await request(limited.app).post(`${BASE}/sessions`).send({ username: 'root', password: ROOT_PASS });
            expect(res.status).toBe(429);
            expect(res.body.error).toBeDefined();
            // X-Forwarded-For is ignored without trustProxy
            expect((await request(limited.app).post(`${BASE}/sessions`).set('X-Forwarded-For', '10.0.0.9').send({ username: 'root', password: ROOT_PASS })).status).toBe(429);
        } finally {
            limited.plugin.dispose();
        }
    });

    it('per-IP limiter honours X-Forwarded-For only with trustProxy', async () => {
        const proxied = await createTestServer({ ipRateLimit: 2, trustProxy: true });
        try {
            // the proxy appends the real client IP; the leftmost entries are client-controlled
            const send = (ip: string, spoofed = '6.6.6.6') => request(proxied.app).post(`${BASE}/sessions`).set('X-Forwarded-For', `${spoofed}, ${ip}`).send({ username: 'nobody', password: 'x' });
            expect((await send('1.1.1.1', '7.7.7.1')).status).toBe(401);
            expect((await send('1.1.1.1', '7.7.7.2')).status).toBe(401);
            expect((await send('1.1.1.1', '7.7.7.3')).status).toBe(429);
            expect((await send('2.2.2.2')).status).toBe(401);
        } finally {
            proxied.plugin.dispose();
        }
    });

    it('verify-password and self password change count toward the per-IP limit', async () => {
        const limited = await createTestServer({ ipRateLimit: 3 });
        try {
            const r = await login(limited.app, 'root', ROOT_PASS); // 1
            await request(limited.app).post(`${BASE}/users/root/verify-password`).set(auth(r.token)).send({ password: ROOT_PASS }).expect(200); // 2
            await request(limited.app).put(`${BASE}/users/root/password`).set(auth(r.token)).send({ password: 'another1', currentPassword: ROOT_PASS }).expect(204); // 3
            const res = await request(limited.app).post(`${BASE}/users/root/verify-password`).set(auth(r.token)).send({ password: 'another1' });
            expect(res.status).toBe(429);
        } finally {
            limited.plugin.dispose();
        }
    });

    it('absolute session lifetime caps expiresAt and ends active sessions', async () => {
        const short = await createTestServer({ maxSessionLifetimeMs: 400, sessionTimeoutMs: 60_000 });
        try {
            const r = await login(short.app, 'root', ROOT_PASS);
            const current = await request(short.app).get(`${BASE}/sessions/current`).set(auth(r.token));
            expect(current.body.expiresAt).toBe(current.body.loginTime + 400);
            for (let i = 0; i < 3; i++) {
                await new Promise((res) => setTimeout(res, 100));
                expect((await request(short.app).get(`${BASE}/sessions/current`).set(auth(r.token))).status).toBe(200);
            }
            await new Promise((res) => setTimeout(res, 200));
            expect((await request(short.app).get(`${BASE}/sessions/current`).set(auth(r.token))).status).toBe(401);
        } finally {
            short.plugin.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// B6 — tokens are stored hashed and never leak
// ---------------------------------------------------------------------------

describe('B6: hashed tokens', () => {
    it('stores SHA-256(token), never the token, and keeps tokens out of audit', async () => {
        const s = await createTestServer();
        const r = await login(s.app, 'root', ROOT_PASS);
        const sessions = await s.plugin.sessionStore.getActiveSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].tokenHash).toBe(createHash('sha256').update(r.token).digest('hex'));
        expect(JSON.stringify(sessions)).not.toContain(r.token);
        expect(await s.plugin.sessionStore.getSession(r.token)).toBeUndefined();

        const t = await request(s.app).post(`${BASE}/sessions/ws-ticket`).set(auth(r.token));
        await request(s.app).post(`${BASE}/sessions`).send({ username: 'root', password: 'wrong-password' });
        const audit = JSON.stringify(await s.plugin.auditStore.getEntries());
        expect(audit).not.toContain(r.token);
        expect(audit).not.toContain(t.body.ticket);
        expect(audit).not.toContain('wrong-password');
        expect(audit).not.toContain(ROOT_PASS);
        s.plugin.dispose();
    });
});

// ---------------------------------------------------------------------------
// B7 — input validation
// ---------------------------------------------------------------------------

describe('B7: input validation', () => {
    let s: TestServer;
    let root: string;
    beforeAll(async () => {
        s = await createTestServer();
        root = (await login(s.app, 'root', ROOT_PASS)).token;
    });
    afterAll(() => s.plugin.dispose());

    const post = (p: string, b: object) => request(s.app).post(`${BASE}${p}`).set(auth(root)).send(b);

    it('rejects invalid user fields with 400 {error}', async () => {
        const bad: object[] = [
            { name: '', email: 'a@b.c' },
            { name: '-lead', email: 'a@b.c' },
            { name: 'has space', email: 'a@b.c' },
            { name: 'x'.repeat(65), email: 'a@b.c' },
            { name: 'ctl\u0007', email: 'a@b.c' },
            { name: 'okname', email: 'no-at-sign' },
            { name: 'okname', email: 'a b@c.d' },
            { name: 'okname', email: `${'x'.repeat(250)}@b.cd` },
            { name: 'okname', email: 'esc\u001b[31m@b.c' },
            { name: 'okname', email: 'ok@b.c', homeDir: '/h\u0000x' },
            { name: 'okname', email: 'ok@b.c', data: { blob: 'x'.repeat(17 * 1024) } },
        ];
        for (const body of bad) {
            const res = await post('/users', body);
            expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
            expect(Object.keys(res.body)).toEqual(['error']);
        }
        expect((await post('/users', { name: 'a.b_c-d@e', email: 'user@localhost' })).status).toBe(201);
    });

    it('rejects invalid group fields with 400 {error}', async () => {
        const bad: object[] = [
            { name: 'bad name' },
            { name: 'g1', description: 'x'.repeat(257) },
            { name: 'g1', description: 'line\nbreak' },
            { name: 'g1', permissions: ['users:read:'] },
            { name: 'g1', permissions: ['users read'] },
            { name: 'g1', permissions: ['*:*x'] },
            { name: 'g1', permissions: ['x'.repeat(129)] },
            { name: 'g1', permissions: Array.from({ length: 101 }, (_, i) => `p${i}:read`) },
        ];
        for (const body of bad) {
            const res = await post('/groups', body);
            expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
            expect(res.body.error).toBeDefined();
        }
        expect((await post('/groups', { name: 'g1', permissions: ['*', 'Users:*', 'a.b-c_d:e', 'x:y:z'] })).status).toBe(201);
    });

    it('name and email share one uniqueness namespace (409)', async () => {
        await createUser(s.app, root, { name: 'carl', email: 'carl@x.io' });
        expect((await post('/users', { name: 'carl@x.io', email: 'other@x.io' })).status).toBe(409);
        await createUser(s.app, root, { name: 'dora@x.io', email: 'dora@y.io' });
        expect((await post('/users', { name: 'dee', email: 'DORA@x.io' })).status).toBe(409);
        expect((await request(s.app).put(`${BASE}/users/carl`).set(auth(root)).send({ email: 'dora@x.io' })).status).toBe(409);
    });

    it('limits request bodies on users routes to 1 MB', async () => {
        const app = express();
        app.use(s.plugin.prefix, s.plugin.router);
        const res = await request(app).post(`${BASE}/groups`).set(auth(root)).set('Content-Type', 'application/json')
            .send(JSON.stringify({ name: 'big', description: 'x'.repeat(1_100_000) }));
        expect(res.status).toBe(413);
        expect(res.body.error).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// B8 — audit
// ---------------------------------------------------------------------------

describe('B8: audit', () => {
    it('adds userId/actorId and sanitizes unknown login names', async () => {
        const s = await createTestServer();
        const r = await login(s.app, 'root', ROOT_PASS);
        const id = await createUser(s.app, r.token, { name: 'aud', email: 'aud@x.io' });
        const created = (await s.plugin.auditStore.getEntries({ event: 'user_created' }))[0];
        expect(created).toMatchObject({ username: 'aud', userId: id, actor: 'root', actorId: r.userId });

        const attempted = `\u001b[31mevil\nname${'y'.repeat(100)}`;
        await request(s.app).post(`${BASE}/sessions`).send({ username: attempted, password: 'x' });
        const failed = (await s.plugin.auditStore.getEntries({ event: 'login_failed' }))[0];
        expect(failed.username).toHaveLength(64);
        expect(failed.username).not.toMatch(/[\u0000-\u001f\u007f]/);
        expect(failed.username.startsWith('[31mevilname')).toBe(true);
        s.plugin.dispose();
    });

    it('caps failed-login entries separately so they cannot evict history', async () => {
        const s = await createTestServer();
        const store = s.plugin.auditStore;
        await store.clear();
        await store.log({ timestamp: Date.now(), event: 'user_created', username: 'keep' });
        for (let i = 0; i < 300; i++) {
            await store.log({ timestamp: Date.now(), event: 'login_failed', username: `x${i}` });
        }
        const all = await store.getEntries();
        expect(all.filter((e) => e.event === 'login_failed')).toHaveLength(200);
        expect(all.some((e) => e.username === 'keep')).toBe(true);
        expect(all[0].username).toBe('x299');
        s.plugin.dispose();
    });
});

// ---------------------------------------------------------------------------
// B9 — CSRF in adapter / cookie mode
// ---------------------------------------------------------------------------

describe('B9: CSRF', () => {
    const ORIGIN = 'http://localhost:4300';
    const admin: User = { id: 'a1', name: 'boss', email: 'boss@host.io', groups: [], createdAt: 0, updatedAt: 0 };
    const adapter: AuthAdapter = (req: Request) => (req.headers.cookie?.includes('sid=ok') ? { user: admin, isAdmin: true } : null);

    it('state-changing adapter requests need an allowed Origin or a bearer header', async () => {
        const plugin = new CliUsersBuilder().setAuthAdapter(adapter).setAllowedOrigins([ORIGIN]).build();
        await plugin.ready;
        const app = express();
        app.use(plugin.prefix, plugin.router);
        const body = { name: 'g2' };

        const noOrigin = await request(app).post(`${BASE}/groups`).set('Cookie', 'sid=ok').send(body);
        expect(noOrigin.status).toBe(403);
        expect(noOrigin.body.error).toBeDefined();
        expect((await request(app).post(`${BASE}/groups`).set('Cookie', 'sid=ok').set('Origin', 'https://evil.example').send(body)).status).toBe(403);
        expect((await request(app).post(`${BASE}/groups`).set('Cookie', 'sid=ok').set('Origin', ORIGIN).send(body)).status).toBe(201);
        // bearer-carrying requests are not CSRF-able
        expect((await request(app).post(`${BASE}/groups`).set('Cookie', 'sid=ok').set('Authorization', 'Bearer host-jwt').send({ name: 'g3' })).status).toBe(201);
        // reads are not affected
        expect((await request(app).get(`${BASE}/groups`).set('Cookie', 'sid=ok')).status).toBe(200);

        // protected server routes too
        const req = { method: 'POST', headers: { cookie: 'sid=ok' } } as unknown as Request;
        await expect(plugin.serverAuth.authenticateRequest(req)).rejects.toMatchObject({ status: 403 });
        plugin.dispose();
    });
});
