/**
 * `GET /api/v1/qcli/permissions` (users plugin): the permission catalog entries the
 * caller holds, or every entry with `?all=true` and `users:read`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult, USERS_PERMISSION_ENTRIES } from '../../plugins/users/index';
import { BASE, ROOT_PASS, auth, createGroup, createTestServer, createUser, login } from './users-test-helpers';

let plugins: UsersPluginResult[] = [];

afterEach(() => {
    for (const p of plugins) p.dispose();
    plugins = [];
});

async function startServer(): Promise<{ cli: CliServerResult; plugin: UsersPluginResult }> {
    const cli = createCliServer({});
    cli.builder.addPermissions([{ name: 'rates:read', description: 'Official exchange rates', group: 'Rates' }]);
    const plugin = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setMinPasswordLength(4).setIpRateLimit(10_000).build();
    plugins.push(plugin);
    cli.mountPlugin(plugin);
    await plugin.ready;
    return { cli, plugin };
}

const names = (body: { name: string }[]) => body.map((p) => p.name);

describe('GET /permissions', () => {
    it('root gets every entry: core, the users plugin, then the host', async () => {
        const { cli } = await startServer();
        const root = await login(cli.app, 'root', ROOT_PASS);
        const res = await request(cli.app).get(`${BASE}/permissions`).set(auth(root.token));
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(28);
        expect(res.body[0]).toEqual({ name: 'commands:execute', description: 'Run commands on the server', group: 'Commands', surface: 'cli' });
        expect(res.body[15]).toEqual({ name: 'users:read', description: 'See users and their permissions', group: 'Users', surface: 'cli' });
        expect(res.body[27]).toEqual({ name: 'rates:read', description: 'Official exchange rates', group: 'Rates', surface: 'host' });
        for (const entry of res.body) {
            expect(Object.keys(entry)).toEqual(['name', 'description', 'group', 'surface']);
        }
    });

    it('a user gets the entries they hold (wildcards match)', async () => {
        const { cli } = await startServer();
        const root = await login(cli.app, 'root', ROOT_PASS);
        await createGroup(cli.app, root.token, { name: 'readers', permissions: ['files:read', 'rates:*'] });
        await createUser(cli.app, root.token, { name: 'alice', email: 'a@example.com', password: 'alicepw', groups: ['readers'] });
        const alice = await login(cli.app, 'alice', 'alicepw');
        const res = await request(cli.app).get(`${BASE}/permissions`).set(auth(alice.token));
        expect(res.status).toBe(200);
        expect(names(res.body)).toEqual(['files:read', 'rates:read']);
        expect(names((await request(cli.app).get(`${BASE}/permissions?all=false`).set(auth(alice.token))).body)).toEqual([
            'files:read',
            'rates:read',
        ]);

        const all = await request(cli.app).get(`${BASE}/permissions?all=true`).set(auth(alice.token));
        expect(all.status).toBe(403);
        expect(all.body).toEqual({ error: 'permission denied: users:read' });
    });

    it('?all=true with users:read returns every entry', async () => {
        const { cli } = await startServer();
        const root = await login(cli.app, 'root', ROOT_PASS);
        await createGroup(cli.app, root.token, { name: 'auditors', permissions: ['users:read'] });
        await createUser(cli.app, root.token, { name: 'bob', email: 'b@example.com', password: 'bobpw', groups: ['auditors'] });
        const bob = await login(cli.app, 'bob', 'bobpw');
        expect(names((await request(cli.app).get(`${BASE}/permissions`).set(auth(bob.token))).body)).toEqual(['users:read']);
        const all = await request(cli.app).get(`${BASE}/permissions?all=true`).set(auth(bob.token));
        expect(all.status).toBe(200);
        expect(all.body).toHaveLength(28);
        const rootAll = await request(cli.app).get(`${BASE}/permissions?all=true`).set(auth((await login(cli.app, 'root', ROOT_PASS)).token));
        expect(rootAll.body).toHaveLength(28);
    });

    it('?all=<other> → 400; anonymous → 401', async () => {
        const { cli } = await startServer();
        const root = await login(cli.app, 'root', ROOT_PASS);
        const bad = await request(cli.app).get(`${BASE}/permissions?all=yes`).set(auth(root.token));
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ error: 'all must be true or false' });
        const anonymous = await request(cli.app).get(`${BASE}/permissions`);
        expect(anonymous.status).toBe(401);
        expect(anonymous.body).toEqual({ error: 'unauthorized' });
    });

    it('a scoped token sees only the entries its scope covers', async () => {
        const { cli } = await startServer();
        const root = await login(cli.app, 'root', ROOT_PASS);
        const created = await request(cli.app).post(`${BASE}/tokens`).set(auth(root.token)).send({ name: 'ro', permissions: ['files:read'] });
        expect(created.status).toBe(201);
        const res = await request(cli.app).get(`${BASE}/permissions`).set(auth(created.body.token));
        expect(res.status).toBe(200);
        expect(names(res.body)).toEqual(['files:read']);
    });

    it('standalone plugin router serves its own entries', async () => {
        const { app, plugin } = await createTestServer();
        plugins.push(plugin);
        const root = await login(app, 'root', ROOT_PASS);
        const res = await request(app).get(`${BASE}/permissions`).set(auth(root.token));
        expect(res.status).toBe(200);
        expect(names(res.body)).toEqual(USERS_PERMISSION_ENTRIES.map((p) => p.name));
        expect(res.body).toHaveLength(12);
        expect(res.body.every((p: { surface: string }) => p.surface === 'cli')).toBe(true);
    });

    it('the users plugin entries are added once, also when attached again', async () => {
        const { cli, plugin } = await startServer();
        cli.setAuth(undefined);
        cli.setAuth(plugin.serverAuth);
        expect(cli.builder.permissions.all()).toHaveLength(28);
        expect(plugin.authService.permissionCatalog()).toBe(cli.builder.permissions);
    });

    it('a host registering a name the users plugin owns fails at mount', async () => {
        const cli = createCliServer({ configure: (b) => b.addPermissions([{ name: 'users:read', description: 'x', group: 'g' }]) });
        const plugin = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).build();
        plugins.push(plugin);
        expect(() => cli.mountPlugin(plugin)).toThrow('permission already registered: users:read');

        // a collision on a later entry throws too, and adds nothing (all or nothing)
        const cli2 = createCliServer({ configure: (b) => b.addPermissions([{ name: 'tokens:revoke', description: 'x', group: 'g' }]) });
        const plugin2 = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).build();
        plugins.push(plugin2);
        expect(() => cli2.mountPlugin(plugin2)).toThrow('permission already registered: tokens:revoke');
        expect(cli2.builder.permissions.find('users:read')).toBeUndefined();
    });

    it('attaching the same plugin to one catalog again neither throws nor duplicates', async () => {
        const { cli, plugin } = await startServer();
        expect(() => cli.setAuth(plugin.serverAuth)).not.toThrow();
        cli.setAuth(undefined);
        expect(() => cli.setAuth(plugin.serverAuth)).not.toThrow();
        expect(() => plugin.serverAuth.attachToServer({ broadcast: () => undefined, permissions: cli.builder.permissions })).not.toThrow();
        expect(cli.builder.permissions.all()).toHaveLength(28);
        expect(cli.builder.permissions.find('users:read')?.surface).toBe('cli');
    });
});
