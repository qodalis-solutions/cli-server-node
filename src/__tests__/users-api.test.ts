import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import express, { Request } from 'express';
import request from 'supertest';
import { buildUsersPlugin, CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { User, AuthAdapter } from '../../plugins/users/models';
import { BASE, ROOT_PASS, TestServer, auth, createTestServer, createUser, createGroup, login } from './users-test-helpers';

// ---------------------------------------------------------------------------
// Builder / registration
// ---------------------------------------------------------------------------

describe('CliUsersBuilder', () => {
    it('builds synchronously and seeds through ready', async () => {
        const plugin = new CliUsersBuilder().setDefaultAdminPassword('pw12').setSessionTimeout(1000).build();
        expect(plugin.prefix).toBe('/api/v1/qcli');
        expect(plugin.ready).toBeInstanceOf(Promise);
        await plugin.ready;
        const groups = await plugin.groupStore.getGroups();
        expect(groups.map((g) => g.name).sort()).toEqual(['admin', 'users']);
        const admin = groups.find((g) => g.name === 'admin')!;
        expect(admin.permissions).toEqual(['*']);
        expect(admin.builtIn).toBe(true);
        const usersGroup = groups.find((g) => g.name === 'users')!;
        expect(usersGroup.permissions).toEqual([]);
        expect(usersGroup.builtIn).toBe(true);
        const root = await plugin.userStore.getUser('root');
        expect(root).toMatchObject({ email: 'root@localhost', groups: ['admin'] });
        expect(await plugin.authService.verifyPassword(root!.id, 'pw12')).toBe(true);
        plugin.dispose();
    });

    it('requests arriving before seeding completes wait for ready', async () => {
        const plugin = new CliUsersBuilder().setDefaultAdminPassword('early').build();
        const app = express();
        app.use(plugin.prefix, plugin.router);
        const res = await request(app).post(`${BASE}/sessions`).send({ username: 'root', password: 'early' });
        expect(res.status).toBe(201);
        plugin.dispose();
    });

    it('keeps buildUsersPlugin as a deprecated async wrapper', async () => {
        const plugin = await buildUsersPlugin({ defaultAdminPassword: 'legacy' });
        expect(await plugin.userStore.getUser('root')).toBeDefined();
        plugin.dispose();
    });

    it('uses custom stores passed to the builder', async () => {
        const { InMemoryUserStore } = await import('../../plugins/users/index');
        const store = new InMemoryUserStore();
        await store.createUser({ name: 'preexisting', email: 'pre@x.com', groups: ['admin'] });
        const plugin = new CliUsersBuilder().setUserStore(store).build();
        await plugin.ready;
        expect(plugin.userStore).toBe(store);
        expect(await store.getUser('root')).toBeUndefined(); // store not empty → no root seed
        plugin.dispose();
    });
});

// ---------------------------------------------------------------------------
// Login / sessions
// ---------------------------------------------------------------------------

describe('Sessions', () => {
    let s: TestServer;
    let rootToken: string;

    beforeEach(async () => {
        s = await createTestServer();
        rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
    });
    afterEach(() => s.plugin.dispose());

    it('POST /sessions returns 201 with the contract shape', async () => {
        const res = await request(s.app).post(`${BASE}/sessions`).send({ username: 'root', password: ROOT_PASS });
        expect(res.status).toBe(201);
        expect(typeof res.body.token).toBe('string');
        const session = res.body.session;
        expect(Object.keys(session).sort()).toEqual(['expiresAt', 'id', 'lastActivity', 'loginTime', 'permissions', 'user']);
        expect(session.permissions).toEqual(['*']);
        expect(session.user).toMatchObject({ name: 'root', email: 'root@localhost', groups: ['admin'], disabled: false });
        expect(session.user.lastLoginAt).toBeGreaterThan(0);
        expect(session.expiresAt).toBe(session.lastActivity + 30 * 60 * 1000);
        expect(JSON.stringify(session)).not.toContain(res.body.token);
    });

    it('logs in by email', async () => {
        const res = await request(s.app).post(`${BASE}/sessions`).send({ username: 'ROOT@localhost', password: ROOT_PASS });
        expect(res.status).toBe(201);
    });

    it('returns 401 {error} for a wrong password or unknown user', async () => {
        const bad = await request(s.app).post(`${BASE}/sessions`).send({ username: 'root', password: 'nope' });
        expect(bad.status).toBe(401);
        expect(bad.body).toEqual({ error: expect.any(String) });
        const unknown = await request(s.app).post(`${BASE}/sessions`).send({ username: 'ghost', password: 'nope' });
        expect(unknown.status).toBe(401);
        expect(unknown.body.error).toBeDefined();
    });

    it('returns 400 when username or password is missing', async () => {
        expect((await request(s.app).post(`${BASE}/sessions`).send({ password: 'x' })).status).toBe(400);
        const res = await request(s.app).post(`${BASE}/sessions`).send({ username: 'root' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    it('returns 403 account disabled for a disabled user with the right password', async () => {
        await createUser(s.app, rootToken, { name: 'dis', email: 'dis@x.com', password: 'pass', disabled: true });
        const res = await request(s.app).post(`${BASE}/sessions`).send({ username: 'dis', password: 'pass' });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'account disabled' });
    });

    it('locks out after 5 failures with 429', async () => {
        await createUser(s.app, rootToken, { name: 'lucy', email: 'lucy@x.com', password: 'pass' });
        for (let i = 0; i < 5; i++) {
            const r = await request(s.app).post(`${BASE}/sessions`).send({ username: 'lucy', password: 'bad' });
            expect(r.status).toBe(401);
        }
        const res = await request(s.app).post(`${BASE}/sessions`).send({ username: 'lucy@x.com', password: 'pass' });
        expect(res.status).toBe(429);
        expect(res.body).toEqual({ error: 'account locked, try again later' });
    });

    it('persists lastLoginAt on the user', async () => {
        const res = await request(s.app).get(`${BASE}/users/root`).set(auth(rootToken));
        expect(res.body.lastLoginAt).toBeGreaterThan(0);
    });

    it('GET /sessions/current returns the login session shape', async () => {
        const res = await request(s.app).get(`${BASE}/sessions/current`).set(auth(rootToken));
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'id', 'lastActivity', 'loginTime', 'permissions', 'user']);
        expect(res.body.user.name).toBe('root');
        expect(res.body).not.toHaveProperty('token');
    });

    it('requires auth for /sessions/current', async () => {
        expect((await request(s.app).get(`${BASE}/sessions/current`)).status).toBe(401);
        expect((await request(s.app).delete(`${BASE}/sessions/current`)).status).toBe(401);
        const res = await request(s.app).get(`${BASE}/sessions/current`).set(auth('bogus'));
        expect(res.status).toBe(401);
        expect(res.body.error).toBeDefined();
    });

    it('DELETE /sessions/current logs out', async () => {
        const { token } = await login(s.app, 'root', ROOT_PASS);
        expect((await request(s.app).delete(`${BASE}/sessions/current`).set(auth(token))).status).toBe(204);
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(token))).status).toBe(401);
        const audit = await request(s.app).get(`${BASE}/audit?event=logout`).set(auth(rootToken));
        expect(audit.body.length).toBe(1);
    });

    it('GET /sessions lists sessions without tokens, with current flag', async () => {
        const other = await login(s.app, 'root', ROOT_PASS);
        const res = await request(s.app).get(`${BASE}/sessions`).set(auth(rootToken));
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        for (const view of res.body) {
            expect(Object.keys(view).sort()).toEqual(
                ['createdAt', 'current', 'expiresAt', 'id', 'lastActivity', 'metadata', 'userId', 'userName'],
            );
            expect(view.userName).toBe('root');
            expect(view.expiresAt).toBe(view.lastActivity + 30 * 60 * 1000);
        }
        expect(JSON.stringify(res.body)).not.toContain(rootToken);
        expect(JSON.stringify(res.body)).not.toContain(other.token);
        expect(res.body.filter((v: any) => v.current)).toHaveLength(1);
        expect(res.body.find((v: any) => v.id === other.sessionId).current).toBe(false);
    });

    it('DELETE /sessions/:id revokes, broadcasts session-kicked and audits', async () => {
        const other = await login(s.app, 'root', ROOT_PASS);
        const res = await request(s.app).delete(`${BASE}/sessions/${other.sessionId}`).set(auth(rootToken));
        expect(res.status).toBe(204);
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(other.token))).status).toBe(401);
        expect(s.broadcast).toHaveBeenCalledWith({
            type: 'session-kicked',
            data: { sessionId: other.sessionId, userId: other.userId, reason: 'revoked' },
        });
        const audit = await request(s.app).get(`${BASE}/audit?event=session_revoked`).set(auth(rootToken));
        expect(audit.body[0]).toMatchObject({ event: 'session_revoked', username: 'root', actor: 'root' });
    });

    it('DELETE /sessions/:id returns 404 for an unknown id', async () => {
        const res = await request(s.app).delete(`${BASE}/sessions/nope`).set(auth(rootToken));
        expect(res.status).toBe(404);
        expect(res.body.error).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Idle timeout
// ---------------------------------------------------------------------------

describe('Idle session timeout', () => {
    let s: TestServer;
    afterEach(() => s.plugin.dispose());

    it('expires idle sessions (401) and deletes them', async () => {
        s = await createTestServer({ sessionTimeoutMs: 300 });
        const { token, sessionId } = await login(s.app, 'root', ROOT_PASS);
        await new Promise((r) => setTimeout(r, 400));
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(token))).status).toBe(401);
        expect(await s.plugin.sessionStore.getSessionById(sessionId)).toBeUndefined();
    });

    it('slides lastActivity on each request', async () => {
        s = await createTestServer({ sessionTimeoutMs: 300 });
        const { token } = await login(s.app, 'root', ROOT_PASS);
        for (let i = 0; i < 4; i++) {
            await new Promise((r) => setTimeout(r, 150));
            expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(token))).status).toBe(200);
        }
        const res = await request(s.app).get(`${BASE}/sessions/current`).set(auth(token));
        expect(res.body.expiresAt).toBe(res.body.lastActivity + 300);
    });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

describe('Users', () => {
    let s: TestServer;
    let rootToken: string;

    beforeAll(async () => {
        s = await createTestServer();
        rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
        await createUser(s.app, rootToken, { name: 'alice', email: 'alice@x.com', password: 'pass' });
        await createUser(s.app, rootToken, { name: 'bob', email: 'bob@x.com', password: 'pass' });
        await createUser(s.app, rootToken, { name: 'carol', email: 'carol@corp.io', password: 'pass' });
    });
    afterAll(() => s.plugin.dispose());

    it('POST /users returns 201 User with defaults', async () => {
        const res = await request(s.app).post(`${BASE}/users`).set(auth(rootToken))
            .send({ name: 'dave', email: 'dave@x.com', homeDir: '/home/dave', data: { team: 'a' } });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: 'dave', email: 'dave@x.com', groups: ['users'], disabled: false, homeDir: '/home/dave', data: { team: 'a' } });
        expect(res.body.id).toBeDefined();
        expect(res.body.createdAt).toBeGreaterThan(0);
        expect(res.body.updatedAt).toBeGreaterThan(0);
        expect(res.body).not.toHaveProperty('lastLoginAt');
        expect(res.body).not.toHaveProperty('password');
    });

    it('omits absent optional fields and always includes disabled', async () => {
        const res = await request(s.app).get(`${BASE}/users/alice`).set(auth(rootToken));
        expect(res.body.disabled).toBe(false);
        expect(res.body).not.toHaveProperty('homeDir');
        expect(res.body).not.toHaveProperty('data');
    });

    it('validates input (400)', async () => {
        const cases = [
            { email: 'x@x.com' },
            { name: 'x' },
            { name: 'x', email: 'x@x.com', groups: 'admin' },
            { name: 'x', email: 'x@x.com', disabled: 'yes' },
            { name: 'x', email: 'x@x.com', password: 'abc' }, // too short
        ];
        for (const body of cases) {
            const res = await request(s.app).post(`${BASE}/users`).set(auth(rootToken)).send(body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.body.error).toBeDefined();
        }
    });

    it('rejects unknown groups with 400 unknown group', async () => {
        const res = await request(s.app).post(`${BASE}/users`).set(auth(rootToken))
            .send({ name: 'eve', email: 'eve@x.com', groups: ['nosuch'] });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'unknown group: nosuch' });
    });

    it('rejects duplicate name or email (409), also on update', async () => {
        expect((await request(s.app).post(`${BASE}/users`).set(auth(rootToken)).send({ name: 'ALICE', email: 'new@x.com' })).status).toBe(409);
        expect((await request(s.app).post(`${BASE}/users`).set(auth(rootToken)).send({ name: 'new', email: 'Alice@x.com' })).status).toBe(409);
        expect((await request(s.app).put(`${BASE}/users/bob`).set(auth(rootToken)).send({ name: 'alice' })).status).toBe(409);
        expect((await request(s.app).put(`${BASE}/users/bob`).set(auth(rootToken)).send({ email: 'alice@x.com' })).status).toBe(409);
    });

    it('GET /users supports query, skip and take', async () => {
        const all = await request(s.app).get(`${BASE}/users`).set(auth(rootToken));
        expect(all.status).toBe(200);
        expect(all.body.length).toBeGreaterThanOrEqual(4);

        const q = await request(s.app).get(`${BASE}/users?query=CORP`).set(auth(rootToken));
        expect(q.body.map((u: User) => u.name)).toEqual(['carol']);

        const byName = await request(s.app).get(`${BASE}/users?query=li`).set(auth(rootToken));
        expect(byName.body.map((u: User) => u.name)).toEqual(['alice']);

        const page = await request(s.app).get(`${BASE}/users?skip=1&take=2`).set(auth(rootToken));
        expect(page.body.map((u: User) => u.name)).toEqual(all.body.slice(1, 3).map((u: User) => u.name));

        expect((await request(s.app).get(`${BASE}/users?take=-1`).set(auth(rootToken))).status).toBe(400);
    });

    it('GET /users/:idOrName by id or name; 404 unknown', async () => {
        const byName = await request(s.app).get(`${BASE}/users/alice`).set(auth(rootToken));
        expect(byName.status).toBe(200);
        const byId = await request(s.app).get(`${BASE}/users/${byName.body.id}`).set(auth(rootToken));
        expect(byId.body.name).toBe('alice');
        const missing = await request(s.app).get(`${BASE}/users/ghost`).set(auth(rootToken));
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ error: expect.any(String) });
    });

    it('GET /users/:idOrName/permissions', async () => {
        const res = await request(s.app).get(`${BASE}/users/root/permissions`).set(auth(rootToken));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ userId: expect.any(String), groups: ['admin'], permissions: ['*'] });
    });

    it('PUT /users/:idOrName updates by name and audits', async () => {
        const res = await request(s.app).put(`${BASE}/users/carol`).set(auth(rootToken))
            .send({ email: 'carol@new.io', homeDir: '/h/c', groups: ['USERS'] });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ email: 'carol@new.io', homeDir: '/h/c', groups: ['users'] });
        const audit = await request(s.app).get(`${BASE}/audit?event=user_updated&username=carol`).set(auth(rootToken));
        expect(audit.body[0]).toMatchObject({ actor: 'root' });
    });

    it('PUT /users/:idOrName 404 for unknown user', async () => {
        const res = await request(s.app).put(`${BASE}/users/ghost`).set(auth(rootToken)).send({ email: 'g@x.com' });
        expect(res.status).toBe(404);
    });

    it('rename keeps working (name change)', async () => {
        const id = await createUser(s.app, rootToken, { name: 'temp1', email: 'temp1@x.com' });
        const res = await request(s.app).put(`${BASE}/users/temp1`).set(auth(rootToken)).send({ name: 'temp2' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id, name: 'temp2' });
    });
});

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

describe('Passwords', () => {
    let s: TestServer;
    let rootToken: string;

    beforeEach(async () => {
        s = await createTestServer();
        rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
        await createUser(s.app, rootToken, { name: 'pat', email: 'pat@x.com', password: 'oldpass' });
        await createUser(s.app, rootToken, { name: 'quinn', email: 'quinn@x.com', password: 'qpass' });
    });
    afterEach(() => s.plugin.dispose());

    it('self change requires the correct currentPassword', async () => {
        const { token } = await login(s.app, 'pat', 'oldpass');
        const wrong = await request(s.app).put(`${BASE}/users/pat/password`).set(auth(token)).send({ password: 'newpass', currentPassword: 'bad' });
        expect(wrong.status).toBe(403);
        expect(wrong.body.error).toBeDefined();
        const missing = await request(s.app).put(`${BASE}/users/pat/password`).set(auth(token)).send({ password: 'newpass' });
        expect(missing.status).toBe(400);
        const ok = await request(s.app).put(`${BASE}/users/pat/password`).set(auth(token)).send({ password: 'newpass', currentPassword: 'oldpass' });
        expect(ok.status).toBe(204);
        await login(s.app, 'pat', 'newpass');
    });

    it('self change revokes only the other sessions of the caller', async () => {
        const a = await login(s.app, 'pat', 'oldpass');
        const b = await login(s.app, 'pat', 'oldpass');
        await request(s.app).put(`${BASE}/users/pat/password`).set(auth(a.token)).send({ password: 'newpass', currentPassword: 'oldpass' }).expect(204);
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(a.token))).status).toBe(200);
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(b.token))).status).toBe(401);
        expect(s.broadcast).toHaveBeenCalledWith({
            type: 'session-kicked',
            data: { sessionId: b.sessionId, userId: b.userId, reason: 'password changed' },
        });
        expect(s.broadcast).toHaveBeenCalledTimes(1);
    });

    it('change by users:update needs no current password and revokes all target sessions', async () => {
        const a = await login(s.app, 'pat', 'oldpass');
        const res = await request(s.app).put(`${BASE}/users/pat/password`).set(auth(rootToken)).send({ password: 'reset1' });
        expect(res.status).toBe(204);
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(a.token))).status).toBe(401);
        expect(s.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'session-kicked' }));
        const audit = await request(s.app).get(`${BASE}/audit?event=password_changed`).set(auth(rootToken));
        expect(audit.body[0]).toMatchObject({ username: 'pat', actor: 'root' });
    });

    it('another user without users:update gets 403', async () => {
        const { token } = await login(s.app, 'quinn', 'qpass');
        const res = await request(s.app).put(`${BASE}/users/pat/password`).set(auth(token)).send({ password: 'hacked', currentPassword: 'oldpass' });
        expect(res.status).toBe(403);
    });

    it('enforces the password policy', async () => {
        const res = await request(s.app).put(`${BASE}/users/pat/password`).set(auth(rootToken)).send({ password: 'abc' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/at least 4/);
        const missing = await request(s.app).put(`${BASE}/users/pat/password`).set(auth(rootToken)).send({});
        expect(missing.status).toBe(400);
    });

    it('honours a custom minPasswordLength', async () => {
        const custom = await createTestServer({ minPasswordLength: 10 });
        const token = (await login(custom.app, 'root', ROOT_PASS)).token;
        const res = await request(custom.app).post(`${BASE}/users`).set(auth(token)).send({ name: 'x', email: 'x@x.com', password: 'short' });
        expect(res.status).toBe(400);
        custom.plugin.dispose();
    });

    it('verify-password: self or users:update; failures audited and count toward lockout', async () => {
        const { token } = await login(s.app, 'pat', 'oldpass');
        const ok = await request(s.app).post(`${BASE}/users/pat/verify-password`).set(auth(token)).send({ password: 'oldpass' });
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ valid: true });

        const other = await request(s.app).post(`${BASE}/users/quinn/verify-password`).set(auth(token)).send({ password: 'qpass' });
        expect(other.status).toBe(403);

        const byAdmin = await request(s.app).post(`${BASE}/users/quinn/verify-password`).set(auth(rootToken)).send({ password: 'qpass' });
        expect(byAdmin.body).toEqual({ valid: true });

        expect((await request(s.app).post(`${BASE}/users/pat/verify-password`).set(auth(token)).send({})).status).toBe(400);

        for (let i = 0; i < 5; i++) {
            const bad = await request(s.app).post(`${BASE}/users/pat/verify-password`).set(auth(token)).send({ password: 'wrong' });
            expect(bad.body).toEqual({ valid: false });
        }
        const audit = await request(s.app).get(`${BASE}/audit?event=login_failed&username=pat`).set(auth(rootToken));
        expect(audit.body.length).toBe(5);

        const locked = await request(s.app).post(`${BASE}/sessions`).send({ username: 'pat', password: 'oldpass' });
        expect(locked.status).toBe(429);
    });
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

describe('Groups', () => {
    let s: TestServer;
    let rootToken: string;

    beforeEach(async () => {
        s = await createTestServer();
        rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
    });
    afterEach(() => s.plugin.dispose());

    it('POST /groups returns 201 Group', async () => {
        const res = await request(s.app).post(`${BASE}/groups`).set(auth(rootToken))
            .send({ name: 'DevOps', description: 'Ops team', permissions: ['deploy:*'] });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: 'DevOps', description: 'Ops team', permissions: ['deploy:*'], builtIn: false });
        expect(res.body.id).toBeDefined();
        expect(res.body.createdAt).toBeGreaterThan(0);
        expect(res.body.updatedAt).toBeGreaterThan(0);

        const plain = await request(s.app).post(`${BASE}/groups`).set(auth(rootToken)).send({ name: 'plain' });
        expect(plain.body.permissions).toEqual([]);
        expect(plain.body).not.toHaveProperty('description');
    });

    it('rejects duplicates case-insensitively (409) and bad input (400)', async () => {
        await createGroup(s.app, rootToken, { name: 'devs' });
        expect((await request(s.app).post(`${BASE}/groups`).set(auth(rootToken)).send({ name: 'DEVS' })).status).toBe(409);
        expect((await request(s.app).post(`${BASE}/groups`).set(auth(rootToken)).send({ name: 'ADMIN' })).status).toBe(409);
        expect((await request(s.app).post(`${BASE}/groups`).set(auth(rootToken)).send({})).status).toBe(400);
        expect((await request(s.app).post(`${BASE}/groups`).set(auth(rootToken)).send({ name: 'x', permissions: 'a:b' })).status).toBe(400);
    });

    it('GET /groups and /groups/:name (case-insensitive), 404 unknown', async () => {
        await createGroup(s.app, rootToken, { name: 'DevOps' });
        const list = await request(s.app).get(`${BASE}/groups`).set(auth(rootToken));
        expect(list.body.map((g: any) => g.name).sort()).toEqual(['DevOps', 'admin', 'users']);
        const one = await request(s.app).get(`${BASE}/groups/devops`).set(auth(rootToken));
        expect(one.status).toBe(200);
        expect(one.body.name).toBe('DevOps');
        expect((await request(s.app).get(`${BASE}/groups/nosuch`).set(auth(rootToken))).status).toBe(404);
    });

    it('PUT /groups/:name updates description and permissions', async () => {
        await createGroup(s.app, rootToken, { name: 'ops' });
        const res = await request(s.app).put(`${BASE}/groups/ops`).set(auth(rootToken))
            .send({ description: 'Operations', permissions: ['deploy:run'] });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: 'ops', description: 'Operations', permissions: ['deploy:run'] });
        expect((await request(s.app).put(`${BASE}/groups/nosuch`).set(auth(rootToken)).send({ description: 'x' })).status).toBe(404);
        const audit = await request(s.app).get(`${BASE}/audit?event=group_updated`).set(auth(rootToken));
        expect(audit.body[0]).toMatchObject({ actor: 'root', details: 'ops' });
    });

    it('admin permissions cannot be changed (409); description can', async () => {
        const res = await request(s.app).put(`${BASE}/groups/admin`).set(auth(rootToken)).send({ permissions: ['users:read'] });
        expect(res.status).toBe(409);
        expect(res.body.error).toBeDefined();
        const desc = await request(s.app).put(`${BASE}/groups/admin`).set(auth(rootToken)).send({ description: 'Admins' });
        expect(desc.status).toBe(200);
        expect(desc.body.permissions).toEqual(['*']);
    });

    it('built-in groups cannot be deleted (409)', async () => {
        for (const name of ['admin', 'users', 'Admin']) {
            const res = await request(s.app).delete(`${BASE}/groups/${name}`).set(auth(rootToken));
            expect(res.status, name).toBe(409);
            expect(res.body.error).toBeDefined();
        }
    });

    it('deleting a group removes it from every user (cascade)', async () => {
        await createGroup(s.app, rootToken, { name: 'temp' });
        await createUser(s.app, rootToken, { name: 'm1', email: 'm1@x.com', groups: ['users', 'temp'] });
        await createUser(s.app, rootToken, { name: 'm2', email: 'm2@x.com', groups: ['TEMP'] });
        expect((await request(s.app).delete(`${BASE}/groups/Temp`).set(auth(rootToken))).status).toBe(204);
        expect((await request(s.app).get(`${BASE}/users/m1`).set(auth(rootToken))).body.groups).toEqual(['users']);
        expect((await request(s.app).get(`${BASE}/users/m2`).set(auth(rootToken))).body.groups).toEqual([]);
        expect((await request(s.app).delete(`${BASE}/groups/temp`).set(auth(rootToken))).status).toBe(404);
        const audit = await request(s.app).get(`${BASE}/audit?event=group_deleted`).set(auth(rootToken));
        expect(audit.body).toHaveLength(1);
    });

    it('members: add (POST) by name, list, remove', async () => {
        await createGroup(s.app, rootToken, { name: 'Team' });
        const id = await createUser(s.app, rootToken, { name: 'mem', email: 'mem@x.com' });

        const add = await request(s.app).post(`${BASE}/groups/team/members/mem`).set(auth(rootToken));
        expect(add.status).toBe(204);
        // idempotent
        expect((await request(s.app).post(`${BASE}/groups/TEAM/members/${id}`).set(auth(rootToken))).status).toBe(204);
        const user = await request(s.app).get(`${BASE}/users/mem`).set(auth(rootToken));
        expect(user.body.groups).toEqual(['users', 'Team']);

        const members = await request(s.app).get(`${BASE}/groups/team/members`).set(auth(rootToken));
        expect(members.status).toBe(200);
        expect(members.body.map((u: User) => u.name)).toEqual(['mem']);
        expect(members.body[0].disabled).toBe(false);

        const remove = await request(s.app).delete(`${BASE}/groups/team/members/mem`).set(auth(rootToken));
        expect(remove.status).toBe(204);
        expect((await request(s.app).get(`${BASE}/users/mem`).set(auth(rootToken))).body.groups).toEqual(['users']);

        const audit = await request(s.app).get(`${BASE}/audit?username=mem`).set(auth(rootToken));
        const events = audit.body.map((e: any) => e.event);
        expect(events).toContain('group_member_added');
        expect(events).toContain('group_member_removed');
    });

    it('members: unknown group → 400 on add / 404 on remove; unknown user → 404', async () => {
        await createUser(s.app, rootToken, { name: 'mem', email: 'mem@x.com' });
        const add = await request(s.app).post(`${BASE}/groups/nosuch/members/mem`).set(auth(rootToken));
        expect(add.status).toBe(400);
        expect(add.body).toEqual({ error: 'unknown group: nosuch' });
        expect((await request(s.app).post(`${BASE}/groups/users/members/ghost`).set(auth(rootToken))).status).toBe(404);
        expect((await request(s.app).delete(`${BASE}/groups/nosuch/members/mem`).set(auth(rootToken))).status).toBe(404);
        expect((await request(s.app).delete(`${BASE}/groups/users/members/ghost`).set(auth(rootToken))).status).toBe(404);
        expect((await request(s.app).get(`${BASE}/groups/nosuch/members`).set(auth(rootToken))).status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// Protections & cascades
// ---------------------------------------------------------------------------

describe('Protections and cascades', () => {
    let s: TestServer;
    let rootToken: string;

    beforeEach(async () => {
        s = await createTestServer();
        rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
    });
    afterEach(() => s.plugin.dispose());

    it('cannot delete yourself (409)', async () => {
        const res = await request(s.app).delete(`${BASE}/users/root`).set(auth(rootToken));
        expect(res.status).toBe(409);
        expect(res.body.error).toBeDefined();
    });

    it('last enabled admin cannot be deleted, disabled or removed from admin', async () => {
        // a delegated user manager (not admin) so that "self delete" does not mask the rule
        await createGroup(s.app, rootToken, { name: 'managers', permissions: ['users:*', 'groups:*'] });
        await createUser(s.app, rootToken, { name: 'mgr', email: 'mgr@x.com', password: 'mgrpass', groups: ['managers'] });
        const mgr = (await login(s.app, 'mgr', 'mgrpass')).token;

        expect((await request(s.app).delete(`${BASE}/users/root`).set(auth(mgr))).status).toBe(409);
        expect((await request(s.app).put(`${BASE}/users/root`).set(auth(mgr)).send({ disabled: true })).status).toBe(409);
        expect((await request(s.app).put(`${BASE}/users/root`).set(auth(mgr)).send({ groups: ['users'] })).status).toBe(409);
        expect((await request(s.app).delete(`${BASE}/groups/admin/members/root`).set(auth(mgr))).status).toBe(409);

        // a disabled admin does not count as an enabled member
        await createUser(s.app, rootToken, { name: 'sleeper', email: 's@x.com', groups: ['admin'], disabled: true });
        expect((await request(s.app).delete(`${BASE}/users/root`).set(auth(mgr))).status).toBe(409);

        // with a second enabled admin the rules no longer bite
        await createUser(s.app, rootToken, { name: 'admin2', email: 'a2@x.com', groups: ['admin'] });
        expect((await request(s.app).delete(`${BASE}/groups/admin/members/root`).set(auth(mgr))).status).toBe(204);
        // admin2 is now the last enabled admin
        expect((await request(s.app).put(`${BASE}/users/admin2`).set(auth(mgr)).send({ disabled: true })).status).toBe(409);
    });

    it('deleting a user removes credentials and revokes sessions', async () => {
        const id = await createUser(s.app, rootToken, { name: 'del', email: 'del@x.com', password: 'delpass' });
        const sess = await login(s.app, 'del', 'delpass');
        const res = await request(s.app).delete(`${BASE}/users/del`).set(auth(rootToken));
        expect(res.status).toBe(204);
        expect(await s.plugin.credentialStore.getCredentials(id)).toBeUndefined();
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(sess.token))).status).toBe(401);
        expect(s.broadcast).toHaveBeenCalledWith({
            type: 'session-kicked',
            data: { sessionId: sess.sessionId, userId: id, reason: 'user deleted' },
        });
        expect((await request(s.app).get(`${BASE}/users/del`).set(auth(rootToken))).status).toBe(404);
        const audit = await request(s.app).get(`${BASE}/audit?event=user_deleted`).set(auth(rootToken));
        expect(audit.body[0]).toMatchObject({ username: 'del', actor: 'root' });
    });

    it('disabling a user revokes their sessions; enabling is audited', async () => {
        const id = await createUser(s.app, rootToken, { name: 'dis', email: 'dis@x.com', password: 'dispass' });
        const a = await login(s.app, 'dis', 'dispass');
        const b = await login(s.app, 'dis', 'dispass');
        const res = await request(s.app).put(`${BASE}/users/dis`).set(auth(rootToken)).send({ disabled: true });
        expect(res.status).toBe(200);
        expect(res.body.disabled).toBe(true);
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(a.token))).status).toBe(401);
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(b.token))).status).toBe(401);
        const kicked = s.broadcast.mock.calls.map((c) => c[0]).filter((m) => m.type === 'session-kicked');
        expect(kicked.map((m) => m.data.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
        expect(kicked.every((m) => m.data.userId === id && m.data.reason === 'user disabled')).toBe(true);

        await request(s.app).put(`${BASE}/users/dis`).set(auth(rootToken)).send({ disabled: false }).expect(200);
        const audit = await request(s.app).get(`${BASE}/audit?username=dis`).set(auth(rootToken));
        const events = audit.body.map((e: any) => e.event);
        expect(events).toContain('user_disabled');
        expect(events).toContain('user_enabled');
    });
});

// ---------------------------------------------------------------------------
// Live user resolution
// ---------------------------------------------------------------------------

describe('Live user resolution', () => {
    let s: TestServer;
    let rootToken: string;

    beforeEach(async () => {
        s = await createTestServer();
        rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
    });
    afterEach(() => s.plugin.dispose());

    it('group and permission changes apply to existing sessions immediately', async () => {
        await createUser(s.app, rootToken, { name: 'liv', email: 'liv@x.com', password: 'livpass' });
        const { token } = await login(s.app, 'liv', 'livpass');
        expect((await request(s.app).get(`${BASE}/users`).set(auth(token))).status).toBe(403);

        // promote to admin → immediate access
        await request(s.app).post(`${BASE}/groups/admin/members/liv`).set(auth(rootToken)).expect(204);
        expect((await request(s.app).get(`${BASE}/users`).set(auth(token))).status).toBe(200);
        const current = await request(s.app).get(`${BASE}/sessions/current`).set(auth(token));
        expect(current.body.permissions).toEqual(['*']);
        expect(current.body.user.groups).toContain('admin');

        // demote → stale admin rights are gone
        await request(s.app).delete(`${BASE}/groups/admin/members/liv`).set(auth(rootToken)).expect(204);
        expect((await request(s.app).get(`${BASE}/users`).set(auth(token))).status).toBe(403);

        // grant a permission to the user's group → immediate
        await request(s.app).put(`${BASE}/groups/users`).set(auth(rootToken)).send({ permissions: ['users:read'] }).expect(200);
        expect((await request(s.app).get(`${BASE}/users`).set(auth(token))).status).toBe(200);
    });

    it('disabled or deleted users get 401 on existing tokens', async () => {
        const id = await createUser(s.app, rootToken, { name: 'tmp', email: 'tmp@x.com', password: 'tmppass' });
        const { token } = await login(s.app, 'tmp', 'tmppass');
        await s.plugin.userStore.updateUser(id, { disabled: true }); // directly in the store, no cascade
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(token))).status).toBe(401);

        await s.plugin.userStore.updateUser(id, { disabled: false });
        const second = await login(s.app, 'tmp', 'tmppass');
        await s.plugin.userStore.deleteUser(id);
        expect((await request(s.app).get(`${BASE}/sessions/current`).set(auth(second.token))).status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('Audit', () => {
    let s: TestServer;
    let rootToken: string;

    beforeEach(async () => {
        s = await createTestServer();
        rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
    });
    afterEach(() => s.plugin.dispose());

    it('records events with id, timestamp and actor; supports filters and limit', async () => {
        await createUser(s.app, rootToken, { name: 'au', email: 'au@x.com' });
        await request(s.app).post(`${BASE}/sessions`).send({ username: 'root', password: 'bad' });
        await createGroup(s.app, rootToken, { name: 'g1' });

        const all = await request(s.app).get(`${BASE}/audit`).set(auth(rootToken));
        expect(all.status).toBe(200);
        const events = all.body.map((e: any) => e.event);
        expect(events).toEqual(expect.arrayContaining(['login', 'login_failed', 'user_created', 'group_created']));
        for (const e of all.body) {
            expect(typeof e.id).toBe('string');
            expect(typeof e.timestamp).toBe('number');
            expect(typeof e.username).toBe('string');
        }
        // newest first
        expect(all.body[0].event).toBe('group_created');

        const created = await request(s.app).get(`${BASE}/audit?event=user_created`).set(auth(rootToken));
        expect(created.body).toHaveLength(1);
        expect(created.body[0]).toMatchObject({ username: 'au', actor: 'root' });

        const byUser = await request(s.app).get(`${BASE}/audit?username=root&event=login_failed`).set(auth(rootToken));
        expect(byUser.body).toHaveLength(1);

        const limited = await request(s.app).get(`${BASE}/audit?limit=2`).set(auth(rootToken));
        expect(limited.body).toHaveLength(2);

        expect((await request(s.app).get(`${BASE}/audit?limit=abc`).set(auth(rootToken))).status).toBe(400);
    });

    it('DELETE /audit clears and logs audit_cleared', async () => {
        await createUser(s.app, rootToken, { name: 'au', email: 'au@x.com' });
        expect((await request(s.app).delete(`${BASE}/audit`).set(auth(rootToken))).status).toBe(204);
        const after = await request(s.app).get(`${BASE}/audit`).set(auth(rootToken));
        expect(after.body).toHaveLength(1);
        expect(after.body[0]).toMatchObject({ event: 'audit_cleared', actor: 'root' });
    });

    it('keeps at most 1000 entries in memory', async () => {
        for (let i = 0; i < 1005; i++) {
            await s.plugin.auditStore.log({ timestamp: Date.now(), event: 'test', username: `u${i}` });
        }
        const all = await s.plugin.auditStore.getEntries();
        expect(all).toHaveLength(1000);
        expect(all[0].username).toBe('u1004');
    });
});

// ---------------------------------------------------------------------------
// Routing details: trailing slashes, error bodies
// ---------------------------------------------------------------------------

describe('Routing', () => {
    let s: TestServer;
    let rootToken: string;

    beforeAll(async () => {
        s = await createTestServer();
        rootToken = (await login(s.app, 'root', ROOT_PASS)).token;
    });
    afterAll(() => s.plugin.dispose());

    it('accepts collection paths with and without trailing slash (no redirects)', async () => {
        for (const path of ['/users', '/users/', '/groups', '/groups/', '/sessions', '/sessions/', '/audit', '/audit/', '/users/root', '/users/root/', '/sessions/current/', '/groups/admin/members/']) {
            const res = await request(s.app).get(`${BASE}${path}`).set(auth(rootToken));
            expect(res.status, path).toBe(200);
        }
        const loginSlash = await request(s.app).post(`${BASE}/sessions/`).send({ username: 'root', password: ROOT_PASS });
        expect(loginSlash.status).toBe(201);
        const createSlash = await request(s.app).post(`${BASE}/groups/`).set(auth(rootToken)).send({ name: 'slash' });
        expect(createSlash.status).toBe(201);
    });

    it('every error is a JSON {error} body', async () => {
        const responses = [
            await request(s.app).get(`${BASE}/users`),
            await request(s.app).get(`${BASE}/users/ghost`).set(auth(rootToken)),
            await request(s.app).post(`${BASE}/users`).set(auth(rootToken)).send({}),
            await request(s.app).delete(`${BASE}/groups/admin`).set(auth(rootToken)),
            await request(s.app).post(`${BASE}/sessions`).send({ username: 'root', password: 'bad' }),
        ];
        for (const res of responses) {
            expect(res.headers['content-type']).toMatch(/json/);
            expect(Object.keys(res.body)).toEqual(['error']);
            expect(typeof res.body.error).toBe('string');
        }
    });

    it('rejects malformed JSON with 400 {error} when the host has no body parser', async () => {
        const app = express();
        app.use(s.plugin.prefix, s.plugin.router);
        const res = await request(app).post(`${BASE}/sessions`).set('Content-Type', 'application/json').send('{bad');
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// External Auth Adapter
// ---------------------------------------------------------------------------

describe('External Auth Adapter', () => {
    let app: express.Express;
    let plugin: UsersPluginResult;

    const adminUser: User = {
        id: 'ext-admin-1',
        name: 'extadmin',
        email: 'extadmin@host.com',
        groups: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const regularUser: User = {
        id: 'ext-user-1',
        name: 'extuser',
        email: 'extuser@host.com',
        groups: ['users'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const testAdapter: AuthAdapter = (req: Request) => {
        const header = req.headers['x-test-user'] as string | undefined;
        if (header === 'admin') return { user: adminUser, isAdmin: true };
        if (header === 'user') return { user: regularUser, isAdmin: false };
        return null;
    };

    beforeAll(async () => {
        plugin = new CliUsersBuilder().setAuthAdapter(testAdapter).build();
        await plugin.ready;
        app = express();
        app.use(express.json());
        app.use(plugin.prefix, plugin.router);
    });
    afterAll(() => plugin.dispose());

    it('login, logout, verify-password and password endpoints return 501 {error}', async () => {
        const responses = [
            await request(app).post(`${BASE}/sessions`).send({ username: 'root', password: 'root' }),
            await request(app).delete(`${BASE}/sessions/current`).set('X-Test-User', 'admin'),
            await request(app).post(`${BASE}/users/extadmin/verify-password`).set('X-Test-User', 'admin').send({ password: 'pass' }),
            await request(app).put(`${BASE}/users/extadmin/password`).set('X-Test-User', 'admin').send({ password: 'passpass' }),
        ];
        for (const res of responses) {
            expect(res.status).toBe(501);
            expect(res.body.error).toContain('host application');
        }
    });

    it('seeds built-in groups but no root user', async () => {
        expect(await plugin.userStore.getUser('root')).toBeUndefined();
        expect((await plugin.groupStore.getGroup('admin'))?.permissions).toEqual(['*']);
        expect(await plugin.groupStore.getGroup('users')).toBeDefined();
    });

    it('resolves the adapter user per request with effective permissions', async () => {
        const admin = await request(app).get(`${BASE}/sessions/current`).set('X-Test-User', 'admin');
        expect(admin.status).toBe(200);
        expect(admin.body.user.name).toBe('extadmin');
        expect(admin.body.user.groups).toContain('admin');
        expect(admin.body.permissions).toEqual(['*']);

        const user = await request(app).get(`${BASE}/sessions/current`).set('X-Test-User', 'user');
        expect(user.body.permissions).toEqual([]);
    });

    it('enforces permissions for adapter users', async () => {
        const created = await request(app).post(`${BASE}/users`).set('X-Test-User', 'admin').send({ name: 'managed', email: 'managed@host.com' });
        expect(created.status).toBe(201);
        expect((await request(app).get(`${BASE}/audit`).set('X-Test-User', 'admin')).status).toBe(200);

        expect((await request(app).post(`${BASE}/users`).set('X-Test-User', 'user').send({ name: 'nope', email: 'n@h.com' })).status).toBe(403);
        expect((await request(app).get(`${BASE}/sessions`).set('X-Test-User', 'user')).status).toBe(403);
        expect((await request(app).get(`${BASE}/audit`).set('X-Test-User', 'user')).status).toBe(403);
        expect((await request(app).get(`${BASE}/groups`).set('X-Test-User', 'user')).status).toBe(200);
    });

    it('rejects passwords on user creation in external-auth mode', async () => {
        const res = await request(app).post(`${BASE}/users`).set('X-Test-User', 'admin').send({ name: 'pw', email: 'pw@host.com', password: 'secret' });
        expect(res.status).toBe(400);
    });

    it('adapter sessions are not stored or listed', async () => {
        await request(app).get(`${BASE}/groups`).set('X-Test-User', 'admin');
        const res = await request(app).get(`${BASE}/sessions`).set('X-Test-User', 'admin');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
        expect(await plugin.sessionStore.getActiveSessions()).toEqual([]);
    });

    it('returns 401 when the adapter returns null or no header is present', async () => {
        expect((await request(app).get(`${BASE}/users`).set('X-Test-User', 'unknown')).status).toBe(401);
        const res = await request(app).get(`${BASE}/users`);
        expect(res.status).toBe(401);
        expect(res.body.error).toBeDefined();
    });
});
