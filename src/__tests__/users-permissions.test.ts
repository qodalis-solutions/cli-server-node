/**
 * Permission matrix: every endpoint is enforced by permission strings, not by
 * the `admin` group. A non-admin user in a custom group with specific
 * permissions gets exactly what the group grants.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { permissionMatches, hasPermission } from '../../plugins/users/index';
import { BASE, ROOT_PASS, TestServer, auth, createTestServer, createUser, createGroup, login } from './users-test-helpers';

describe('permissionMatches', () => {
    it('follows cliPermissionMatches semantics', () => {
        expect(permissionMatches('*', 'users:read')).toBe(true);
        expect(permissionMatches('users:*', 'users:read')).toBe(true);
        expect(permissionMatches('USERS:READ', 'users:read')).toBe(true);
        expect(permissionMatches('users:read', 'users:create')).toBe(false);
        expect(permissionMatches('users', 'users:read')).toBe(false);
        expect(permissionMatches('users:read', 'users')).toBe(false);
        expect(permissionMatches('groups:*', 'users:read')).toBe(false);
        expect(hasPermission(['a:b', 'users:*'], 'users:delete')).toBe(true);
        expect(hasPermission(undefined, 'users:delete')).toBe(false);
    });

    it('a `*` grants everything below only as the last segment; elsewhere it matches exactly one segment', () => {
        expect(permissionMatches('*:read', 'users:read')).toBe(true);
        expect(permissionMatches('*:read', 'users:delete')).toBe(false);
        expect(permissionMatches('*:read', 'users:read:x')).toBe(false);
        expect(permissionMatches('*:read', 'users')).toBe(false);
        expect(permissionMatches('*:read', '*')).toBe(false);
        expect(permissionMatches('users:*:read', 'users:audit:read')).toBe(true);
        expect(permissionMatches('users:*:read', 'users:audit:delete')).toBe(false);
        expect(permissionMatches('users:*:read', 'users:audit')).toBe(false);
        expect(permissionMatches('*:READ', 'Users:read')).toBe(true);
        expect(permissionMatches('users:*', 'users:read:x')).toBe(true);
        expect(hasPermission(['*:read'], 'shell:execute')).toBe(false);
        expect(hasPermission(['*:read'], 'admin:access')).toBe(false);
    });
});

describe('Permission matrix', () => {
    let s: TestServer;
    let root: string;
    let helper: { token: string; sessionId: string; userId: string };
    let plain: { token: string; sessionId: string; userId: string };
    let rootSessionId: string;

    beforeAll(async () => {
        s = await createTestServer();
        const r = await login(s.app, 'root', ROOT_PASS);
        root = r.token;
        rootSessionId = r.sessionId;

        // helpdesk: can read users and sessions, revoke sessions, read audit — nothing else
        await createGroup(s.app, root, {
            name: 'helpdesk',
            permissions: ['users:read', 'sessions:read', 'sessions:revoke', 'groups:read', 'commands:execute'],
        });
        await createGroup(s.app, root, { name: 'auditors', permissions: ['audit:read'] });
        await createGroup(s.app, root, { name: 'managers', permissions: ['users:*', 'commands:execute'] });
        await createUser(s.app, root, { name: 'helper', email: 'helper@x.com', password: 'helppass', groups: ['helpdesk'] });
        await createUser(s.app, root, { name: 'plain', email: 'plain@x.com', password: 'plainpass' });
        await createUser(s.app, root, { name: 'target', email: 'target@x.com', password: 'targetpass' });
        helper = await login(s.app, 'helper', 'helppass');
        plain = await login(s.app, 'plain', 'plainpass');
    });
    afterAll(() => s.plugin.dispose());

    const as = (token: string) => ({
        get: (p: string) => request(s.app).get(`${BASE}${p}`).set(auth(token)),
        post: (p: string, body: object = {}) => request(s.app).post(`${BASE}${p}`).set(auth(token)).send(body),
        put: (p: string, body: object = {}) => request(s.app).put(`${BASE}${p}`).set(auth(token)).send(body),
        del: (p: string) => request(s.app).delete(`${BASE}${p}`).set(auth(token)),
    });

    it('the session carries the group permissions', async () => {
        const res = await as(helper.token).get('/sessions/current');
        expect(res.body.permissions).toEqual(['users:read', 'sessions:read', 'sessions:revoke', 'groups:read', 'commands:execute']);
        expect(res.body.user.groups).toEqual(['helpdesk']);
    });

    it('helpdesk: granted endpoints', async () => {
        const h = as(helper.token);
        expect((await h.get('/users')).status).toBe(200);
        expect((await h.get('/users/target')).status).toBe(200);
        expect((await h.get('/users/target/permissions')).status).toBe(200);
        expect((await h.get('/sessions')).status).toBe(200);
        expect((await h.get('/groups')).status).toBe(200);
        expect((await h.get('/groups/admin/members')).status).toBe(200);
    });

    it('helpdesk: denied endpoints (403 {error})', async () => {
        const h = as(helper.token);
        const denied = [
            await h.post('/users', { name: 'n', email: 'n@x.com' }),
            await h.put('/users/target', { email: 't2@x.com' }),
            await h.del('/users/target'),
            await h.put('/users/target/password', { password: 'newpass' }),
            await h.post('/users/target/verify-password', { password: 'targetpass' }),
            await h.post('/groups', { name: 'g' }),
            await h.put('/groups/helpdesk', { permissions: ['*'] }),
            await h.del('/groups/auditors'),
            await h.post('/groups/admin/members/helper'),
            await h.del('/groups/helpdesk/members/helper'),
            await h.get('/audit'),
            await h.del('/audit'),
        ];
        for (const res of denied) {
            expect(res.status, `${res.req.method} ${res.req.path}`).toBe(403);
            expect(res.body.error).toBeDefined();
        }
    });

    it('sessions:revoke lets helpdesk revoke anyone\'s session', async () => {
        const t = await login(s.app, 'target', 'targetpass');
        expect((await as(helper.token).del(`/sessions/${t.sessionId}`)).status).toBe(204);
    });

    it('plain user: self-service only', async () => {
        const p = as(plain.token);
        expect((await p.get('/users')).status).toBe(403);
        expect((await p.get('/users/plain')).status).toBe(200);
        expect((await p.get(`/users/${plain.userId}`)).status).toBe(200);
        expect((await p.get('/users/target')).status).toBe(403);
        expect((await p.get('/users/ghost')).status).toBe(403); // no existence leak
        const perms = await p.get('/users/plain/permissions');
        expect(perms.status).toBe(200);
        expect(perms.body).toEqual({ userId: plain.userId, groups: ['users'], permissions: ['commands:execute'] });
        expect((await p.get('/users/target/permissions')).status).toBe(403);
        expect((await p.get('/sessions')).status).toBe(403);
        expect((await p.get('/groups')).status).toBe(200);
        expect((await p.get('/groups/users')).status).toBe(200);
        expect((await p.get('/groups/users/members')).status).toBe(200); // member
        expect((await p.get('/groups/helpdesk/members')).status).toBe(403); // not a member
        expect((await p.get('/audit')).status).toBe(403);
    });

    it('plain user may change only own email and data', async () => {
        const p = as(plain.token);
        const ok = await p.put('/users/plain', { email: 'plain2@x.com', data: { theme: 'dark' } });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ email: 'plain2@x.com', data: { theme: 'dark' } });
        expect((await p.put('/users/plain', { groups: ['admin'] })).status).toBe(403);
        expect((await p.put('/users/plain', { name: 'renamed' })).status).toBe(403);
        expect((await p.put('/users/plain', { disabled: false })).status).toBe(403);
        expect((await p.put('/users/plain', { homeDir: '/x' })).status).toBe(403);
        expect((await p.put('/users/target', { email: 'x@x.com' })).status).toBe(403);
    });

    it('a user can revoke own sessions but not others', async () => {
        const second = await login(s.app, 'plain', 'plainpass');
        expect((await as(plain.token).del(`/sessions/${second.sessionId}`)).status).toBe(204);
        expect((await as(plain.token).del(`/sessions/${rootSessionId}`)).status).toBe(403);
    });

    it('wildcard users:* grants all user actions but nothing else', async () => {
        await createUser(s.app, root, { name: 'mgr', email: 'mgr@x.com', password: 'mgrpass', groups: ['managers'] });
        const m = as((await login(s.app, 'mgr', 'mgrpass')).token);
        const created = await m.post('/users', { name: 'hire', email: 'hire@x.com', password: 'hirepass' });
        expect(created.status).toBe(201);
        expect((await m.put('/users/hire', { groups: ['managers'] })).status).toBe(200);
        // escalation: auditors grants audit:read, which mgr does not hold
        expect((await m.put('/users/hire', { groups: ['auditors'] })).status).toBe(403);
        expect((await m.put('/users/hire/password', { password: 'reset99' })).status).toBe(204);
        expect((await m.post('/users/hire/verify-password', { password: 'reset99' })).body).toEqual({ valid: true });
        expect((await m.del('/users/hire')).status).toBe(204);
        // cannot act on an admin (P(root) = * is not covered by users:*)
        expect((await m.put('/users/root', { name: 'pwned' })).status).toBe(403);
        expect((await m.get('/audit')).status).toBe(403);
        expect((await m.get('/sessions')).status).toBe(403);
        expect((await m.post('/groups', { name: 'x' })).status).toBe(403);
    });

    it('audit:read alone grants audit read but not clear', async () => {
        await createUser(s.app, root, { name: 'aud', email: 'aud@x.com', password: 'audpass', groups: ['auditors'] });
        const a = as((await login(s.app, 'aud', 'audpass')).token);
        expect((await a.get('/audit')).status).toBe(200);
        expect((await a.del('/audit')).status).toBe(403);
    });

    it('missing or invalid auth is 401 everywhere except login', async () => {
        for (const [method, path] of [
            ['get', '/users'], ['get', '/users/root'], ['post', '/users'], ['get', '/groups'],
            ['post', '/groups'], ['get', '/sessions'], ['delete', '/sessions/x'], ['get', '/audit'],
        ] as const) {
            const res = await (request(s.app) as any)[method](`${BASE}${path}`).set(auth('invalid'));
            expect(res.status, `${method} ${path}`).toBe(401);
        }
    });
});
