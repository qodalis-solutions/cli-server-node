/**
 * `ExternalAuthResult.permissions` and read-only user/group stores
 * (mirrors qodalis-solutions/cli-server-dotnet#27).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer } from '../create-cli-server';
import {
    AuthAdapter,
    CliUsersBuilder,
    ExternalAuthResult,
    InMemoryGroupStore,
    InMemoryUserStore,
    UsersModuleOptions,
    UsersPluginResult,
    User,
} from '../../plugins/users/index';

const V1 = '/api/v1/qcli';
const ORIGIN = 'http://localhost:4300';
const USERS_MSG = { error: 'Users are managed by the host application' };
const GROUPS_MSG = { error: 'Groups are managed by the host application' };

const hostUser = (id: string, extra: Partial<User> = {}): User => ({
    id,
    name: id,
    email: `${id}@host.io`,
    groups: [],
    createdAt: 0,
    updatedAt: 0,
    ...extra,
});

/** Returns whatever the test put in `result` for the `X-Host-User` header. */
let results: Map<string, ExternalAuthResult>;
const adapter: AuthAdapter = (req) => {
    const id = req.headers['x-host-user'];
    return typeof id === 'string' ? results.get(id) ?? null : null;
};

/** Stores that count write calls (they must not be called for read-only stores). */
class CountingUserStore extends InMemoryUserStore {
    writes = 0;
    override async createUser(...a: Parameters<InMemoryUserStore['createUser']>) {
        this.writes++;
        return super.createUser(...a);
    }
    override async updateUser(...a: Parameters<InMemoryUserStore['updateUser']>) {
        this.writes++;
        return super.updateUser(...a);
    }
    override async deleteUser(...a: Parameters<InMemoryUserStore['deleteUser']>) {
        this.writes++;
        return super.deleteUser(...a);
    }
}

class CountingGroupStore extends InMemoryGroupStore {
    writes = 0;
    override async createGroup(...a: Parameters<InMemoryGroupStore['createGroup']>) {
        this.writes++;
        return super.createGroup(...a);
    }
    override async updateGroup(...a: Parameters<InMemoryGroupStore['updateGroup']>) {
        this.writes++;
        return super.updateGroup(...a);
    }
    override async deleteGroup(...a: Parameters<InMemoryGroupStore['deleteGroup']>) {
        this.writes++;
        return super.deleteGroup(...a);
    }
}

const plugins: UsersPluginResult[] = [];
afterEach(() => {
    for (const p of plugins.splice(0)) p.dispose();
});

interface Setup {
    app: express.Express;
    plugin: UsersPluginResult;
    userStore: CountingUserStore;
    groupStore: CountingGroupStore;
}

/** Adapter-mode plugin over pre-filled stores (the host's accounts and roles). */
async function setup(options: UsersModuleOptions = {}, fill?: (u: InMemoryUserStore, g: InMemoryGroupStore) => Promise<void>): Promise<Setup> {
    results = new Map([['host-admin', { user: hostUser('host-admin'), isAdmin: true }]]);
    const userStore = new CountingUserStore();
    const groupStore = new CountingGroupStore();
    await fill?.(userStore, groupStore);
    const plugin = new CliUsersBuilder()
        .setUserStore(userStore)
        .setGroupStore(groupStore)
        .setAllowedOrigins([ORIGIN])
        .setOptions({ authAdapter: adapter, ...options })
        .build();
    plugins.push(plugin);
    await plugin.ready;
    // Only writes made by the requests count (not the fill or the seeding).
    userStore.writes = 0;
    groupStore.writes = 0;
    const app = express();
    app.use(plugin.prefix, plugin.router);
    return { app, plugin, userStore, groupStore };
}

const asAdmin = (r: request.Test) => r.set('X-Host-User', 'host-admin').set('Origin', ORIGIN);

describe('ExternalAuthResult.permissions', () => {
    it('are added to the permissions of the user’s groups', async () => {
        const { app } = await setup();
        results.set('alice', { user: hostUser('alice', { groups: ['users'] }), permissions: ['logs:read', 'commands:execute'] });
        const res = await request(app).get(`${V1}/sessions/current`).set('X-Host-User', 'alice');
        expect(res.status).toBe(200);
        expect(res.body.permissions).toEqual(['commands:execute', 'logs:read']);
    });

    it('with isAdmin keep everything', async () => {
        const { app } = await setup();
        results.set('alice', { user: hostUser('alice'), isAdmin: true, permissions: ['logs:read'] });
        const res = await request(app).get(`${V1}/sessions/current`).set('X-Host-User', 'alice');
        expect(res.body.user.groups).toEqual(['admin']);
        expect(res.body.permissions).toEqual(['*', 'logs:read']);
    });

    it('unknown group names grant nothing (and break nothing)', async () => {
        const { app } = await setup();
        results.set('alice', { user: hostUser('alice', { groups: ['host-role-that-is-not-a-group'] }), permissions: ['logs:read'] });
        const res = await request(app).get(`${V1}/sessions/current`).set('X-Host-User', 'alice');
        expect(res.status).toBe(200);
        expect(res.body.permissions).toEqual(['logs:read']);
    });

    it('alone authorize server routes and open the logs socket', async () => {
        results = new Map([
            ['alice', { user: hostUser('alice'), permissions: ['commands:execute', 'logs:read'] }],
            ['bob', { user: hostUser('bob') }],
        ]);
        const cli = createCliServer({ allowedOrigins: [ORIGIN] });
        const plugin = new CliUsersBuilder().setAuthAdapter(adapter).build((m) => cli.eventSocketManager.broadcastMessage(m));
        plugins.push(plugin);
        cli.mountPlugin(plugin);
        await plugin.ready;
        const server = http.createServer(cli.app);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        cli.logSocketManager.attach(server);
        try {
            const exec = (id: string) => request(cli.app).post(`${V1}/execute`).set('X-Host-User', id).set('Origin', ORIGIN).send({ command: 'echo', value: 'hi' });
            expect((await exec('bob')).status).toBe(403);
            expect((await exec('alice')).status).not.toBe(403);

            const ticket = await request(cli.app).post(`${V1}/sessions/ws-ticket`).set('X-Host-User', 'alice').set('Origin', ORIGIN);
            expect(ticket.status).toBe(201);
            const port = (server.address() as AddressInfo).port;
            const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/v1/qcli/logs?ticket=${ticket.body.ticket}`);
            const first = await new Promise<any>((resolve, reject) => {
                ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
                ws.on('unexpected-response', (_q, r) => reject(new Error(`upgrade rejected ${r.statusCode}`)));
            });
            expect(first).toEqual({ type: 'connected' });
            ws.close();
        } finally {
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
            server.closeAllConnections?.();
            await new Promise<void>((r) => server.close(() => r()));
        }
    });
});

describe('read-only user store (readOnlyUsers)', () => {
    const fill = async (u: InMemoryUserStore) => {
        await u.createUser({ name: 'dave', email: 'dave@host.io', groups: ['users'] });
    };

    const userWrites: [string, string, Record<string, unknown> | undefined][] = [
        ['POST', '/users', { name: 'eve', email: 'eve@host.io' }],
        ['PUT', '/users/dave', { email: 'dave2@host.io' }],
        ['DELETE', '/users/dave', undefined],
        ['PUT', '/users/dave/password', { password: 'newpass123' }],
        ['POST', '/groups/admin/members/dave', undefined],
        ['PUT', '/groups/admin/members/dave', undefined],
        ['DELETE', '/groups/users/members/dave', undefined],
    ];

    for (const [method, path, body] of userWrites) {
        it(`${method} ${path} answers 501 without touching the stores`, async () => {
            const { app, userStore, groupStore } = await setup({ readOnlyUsers: true, authAdapter: undefined }, fill);
            // Before authentication: no credentials at all.
            const req = request(app)[method.toLowerCase() as 'post'](`${V1}${path}`);
            const res = body ? await req.send(body) : await req;
            expect(res.status).toBe(501);
            expect(res.body).toEqual(USERS_MSG);
            expect(userStore.writes).toBe(0);
            expect(groupStore.writes).toBe(0);
        });
    }

    it('answers 501 for an authenticated self update and for malformed JSON bodies', async () => {
        const { app, userStore } = await setup({ readOnlyUsers: true }, fill);
        results.set('dave-ext', { user: (await userStore.getUser('dave'))! });
        const self = await request(app).put(`${V1}/users/dave`).set('X-Host-User', 'dave-ext').set('Origin', ORIGIN).send({ email: 'x@host.io' });
        expect(self.status).toBe(501);
        expect(self.body).toEqual(USERS_MSG);
        const bad = await asAdmin(request(app).post(`${V1}/users`)).set('Content-Type', 'application/json').send('{oops');
        expect(bad.status).toBe(501);
        expect(bad.body).toEqual(USERS_MSG);
    });

    it('password changes keep the external-auth 501 when an adapter is configured', async () => {
        const { app } = await setup({ readOnlyUsers: true }, fill);
        const res = await asAdmin(request(app).put(`${V1}/users/dave/password`)).send({ password: 'newpass123' });
        expect(res.status).toBe(501);
        expect(res.body).toEqual({ error: 'Authentication is managed by the host application' });
    });

    it('no root user is seeded; the built-in groups still are', async () => {
        const { plugin } = await setup({ readOnlyUsers: true, authAdapter: undefined });
        expect(await plugin.userStore.getUsers()).toEqual([]);
        expect(await plugin.groupStore.getGroup('admin')).toBeDefined();
        expect(await plugin.groupStore.getGroup('users')).toBeDefined();
    });

    it('reads still work', async () => {
        const { app } = await setup({ readOnlyUsers: true }, fill);
        const list = await asAdmin(request(app).get(`${V1}/users`));
        expect(list.status).toBe(200);
        expect(list.body.map((u: User) => u.name)).toEqual(['dave']);
        expect((await asAdmin(request(app).get(`${V1}/users/dave`))).body.name).toBe('dave');
        expect((await asAdmin(request(app).get(`${V1}/groups/users/members`))).body.map((u: User) => u.name)).toEqual(['dave']);
    });

    it('deleting a (writable) group leaves the users’ memberships alone', async () => {
        const { app, userStore } = await setup({ readOnlyUsers: true }, async (u, g) => {
            await g.createGroup({ name: 'ops', permissions: ['logs:read'] });
            await u.createUser({ name: 'dave', email: 'dave@host.io', groups: ['ops'] });
        });
        expect((await asAdmin(request(app).delete(`${V1}/groups/ops`))).status).toBe(204);
        expect((await userStore.getUser('dave'))!.groups).toEqual(['ops']);
        expect(userStore.writes).toBe(0);
    });
});

describe('read-only group store (readOnlyGroups)', () => {
    const fill = async (_u: InMemoryUserStore, g: InMemoryGroupStore) => {
        await g.createGroup({ name: 'admin', permissions: ['*'], builtIn: true });
        await g.createGroup({ name: 'users', permissions: ['commands:execute'], builtIn: true });
        await g.createGroup({ name: 'ops', permissions: ['logs:read'] });
    };

    const groupWrites: [string, string, Record<string, unknown> | undefined][] = [
        ['POST', '/groups', { name: 'devs', permissions: ['commands:execute'] }],
        ['PUT', '/groups/ops', { description: 'Ops' }],
        ['DELETE', '/groups/ops', undefined],
    ];

    for (const [method, path, body] of groupWrites) {
        it(`${method} ${path} answers 501 without touching the store`, async () => {
            const { app, groupStore } = await setup({ readOnlyGroups: true }, fill);
            const req = asAdmin(request(app)[method.toLowerCase() as 'post'](`${V1}${path}`));
            const res = body ? await req.send(body) : await req;
            expect(res.status).toBe(501);
            expect(res.body).toEqual(GROUPS_MSG);
            expect(groupStore.writes).toBe(0);
        });
    }

    it('built-in groups are not seeded, and reads work', async () => {
        const { app, plugin } = await setup({ readOnlyGroups: true }, async (_u, g) => {
            await g.createGroup({ name: 'ops', permissions: ['logs:read'] });
        });
        expect(await plugin.groupStore.getGroups()).toHaveLength(1);
        expect(await plugin.groupStore.getGroup('users')).toBeUndefined();
        const list = await asAdmin(request(app).get(`${V1}/groups`));
        expect(list.status).toBe(200);
        expect(list.body.map((g: { name: string }) => g.name)).toEqual(['ops']);
    });

    it('with writable users, user writes and memberships keep working', async () => {
        const { app, userStore } = await setup({ readOnlyGroups: true }, fill);
        expect((await asAdmin(request(app).post(`${V1}/users`)).send({ name: 'eve', email: 'eve@host.io' })).status).toBe(201);
        expect((await asAdmin(request(app).post(`${V1}/groups/ops/members/eve`))).status).toBe(204);
        expect((await userStore.getUser('eve'))!.groups).toContain('ops');
        expect((await asAdmin(request(app).delete(`${V1}/groups/ops/members/eve`))).status).toBe(204);
        expect((await userStore.getUser('eve'))!.groups).not.toContain('ops');
    });
});

describe('writable stores are unaffected', () => {
    it('user and group writes work and both stores are seeded', async () => {
        const { app, plugin } = await setup();
        expect(await plugin.groupStore.getGroup('admin')).toBeDefined();
        expect((await asAdmin(request(app).post(`${V1}/groups`)).send({ name: 'devs' })).status).toBe(201);
        expect((await asAdmin(request(app).post(`${V1}/users`)).send({ name: 'eve', email: 'eve@host.io' })).status).toBe(201);
        expect((await asAdmin(request(app).post(`${V1}/groups/devs/members/eve`))).status).toBe(204);
        expect((await asAdmin(request(app).put(`${V1}/groups/devs`)).send({ description: 'Devs' })).status).toBe(200);
        expect((await asAdmin(request(app).delete(`${V1}/groups/devs`))).status).toBe(204);
        expect((await asAdmin(request(app).delete(`${V1}/users/eve`))).status).toBe(204);
    });
});

describe('session payloads publish usersReadOnly and groupsReadOnly', () => {
    for (const [users, groups] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
    ]) {
        it(`GET /sessions/current (adapter) with users=${users}, groups=${groups}`, async () => {
            const { app } = await setup({ readOnlyUsers: users, readOnlyGroups: groups });
            const res = await asAdmin(request(app).get(`${V1}/sessions/current`));
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ usersReadOnly: users, groupsReadOnly: groups });
        });
    }

    it('login response session and GET /sessions/current (stored session)', async () => {
        const userStore = new InMemoryUserStore();
        const dave = await userStore.createUser({ name: 'dave', email: 'dave@host.io', groups: ['admin'] });
        const plugin = new CliUsersBuilder().setUserStore(userStore).setReadOnlyUsers().setIpRateLimit(10_000).build();
        plugins.push(plugin);
        await plugin.ready;
        await plugin.authService.setPassword(dave.id, 'davepass1');
        const app = express();
        app.use(plugin.prefix, plugin.router);

        const login = await request(app).post(`${V1}/sessions`).send({ username: 'dave', password: 'davepass1' });
        expect(login.status).toBe(201);
        expect(login.body.session).toMatchObject({ usersReadOnly: true, groupsReadOnly: false });
        const current = await request(app).get(`${V1}/sessions/current`).set('Authorization', `Bearer ${login.body.token}`);
        expect(current.body).toMatchObject({ usersReadOnly: true, groupsReadOnly: false });
    });

    it('builder setters and raw options set the flags', async () => {
        const fluent = new CliUsersBuilder().setReadOnlyUsers().setReadOnlyGroups().build();
        const off = new CliUsersBuilder().setDefaultAdminPassword('rootpass1').setReadOnlyUsers().setReadOnlyUsers(false).build();
        const raw = new CliUsersBuilder().setOptions({ readOnlyUsers: true, readOnlyGroups: true }).build();
        plugins.push(fluent, off, raw);
        expect([fluent.authService.usersReadOnly, fluent.authService.groupsReadOnly]).toEqual([true, true]);
        expect([off.authService.usersReadOnly, off.authService.groupsReadOnly]).toEqual([false, false]);
        expect([raw.authService.usersReadOnly, raw.authService.groupsReadOnly]).toEqual([true, true]);
        await Promise.all([fluent.ready, off.ready, raw.ready]);
    });
});
