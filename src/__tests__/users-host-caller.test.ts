/**
 * Guarded host routes expose the caller (`req.qcliCaller`), and `requireHostToken`
 * accepts only `host` tokens: the audience is checked before the permission.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { BASE, ROOT_PASS, auth, login } from './users-test-helpers';

const HOST_ONLY = 'forbidden: a host token is required';

interface Harness {
    cli: CliServerResult;
    plugin: UsersPluginResult;
    userId: string;
    groupName: string;
}

const harnesses: Harness[] = [];

afterEach(() => {
    while (harnesses.length) {
        const h = harnesses.pop()!;
        h.plugin.dispose();
        h.cli.eventSocketManager.dispose();
        h.cli.logSocketManager.dispose();
    }
});

async function start(): Promise<Harness> {
    const cli = createCliServer();
    cli.builder.addPermissions([
        { name: 'rates:read', description: 'Official exchange rates', group: 'Rates' },
        { name: 'banks:read', description: 'Banks and their buy and sell rates', group: 'Rates' },
    ]);
    const plugin = new CliUsersBuilder()
        .setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4, ipRateLimit: 10_000 })
        .build();
    await plugin.ready;
    cli.mountPlugin(plugin);
    cli.app.get('/host/caller', plugin.requirePermission('rates:read'), (req, res) => {
        res.json(req.qcliCaller);
    });
    cli.app.get('/host/only', plugin.requireHostToken('rates:read'), (req, res) => {
        res.json(req.qcliCaller);
    });
    const groupName = 'customers';
    await plugin.groupStore.createGroup({ name: groupName, permissions: ['commands:execute', 'rates:read', 'banks:read'] });
    const user = await plugin.userStore.createUser({ name: 'alice', email: 'alice@example.com', groups: [groupName] });
    await plugin.authService.setPassword(user.id, 'alicepass');
    const h = { cli, plugin, userId: user.id, groupName };
    harnesses.push(h);
    return h;
}

async function hostToken(h: Harness, permissions = ['rates:read']): Promise<{ token: string; id: string }> {
    const created = await h.plugin.apiTokens.create(h.userId, { name: `site ${permissions.join(' ').replace(/:/g, '.')}`, audience: 'host', permissions });
    return { token: created.token, id: created.apiToken.id };
}

async function session(h: Harness): Promise<string> {
    return (await login(h.cli.app, 'alice', 'alicepass')).token;
}

async function cliToken(h: Harness, permissions?: string[]): Promise<string> {
    const res = await request(h.cli.app)
        .post(`${BASE}/tokens`)
        .set(auth(await session(h)))
        .send({ name: `cli ${permissions?.join(' ').replace(/:/g, '.') ?? 'all'} ${Math.random().toString(36).slice(2, 8)}`, ...(permissions ? { permissions } : {}) });
    expect(res.status).toBe(201);
    return res.body.token;
}

describe('req.qcliCaller', () => {
    it('caller for a host token', async () => {
        const h = await start();
        const { token, id } = await hostToken(h);
        const res = await request(h.cli.app).get('/host/caller').set(auth(token));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ userId: h.userId, userName: 'alice', tokenId: id, audience: 'host', permissions: ['rates:read'] });
        expect(Object.keys(res.body)).toEqual(['userId', 'userName', 'tokenId', 'audience', 'permissions']);
    });

    it('caller for a session', async () => {
        const h = await start();
        const res = await request(h.cli.app).get('/host/caller').set(auth(await session(h)));
        expect(res.status).toBe(200);
        expect(res.body.userId).toBe(h.userId);
        expect(res.body.userName).toBe('alice');
        expect(res.body.tokenId).toBeNull();
        expect(res.body.audience).toBeNull();
        expect(res.body.permissions).toEqual(expect.arrayContaining(['rates:read']));
    });

    it('caller for a cli token has the cli audience', async () => {
        const h = await start();
        const res = await request(h.cli.app).get('/host/caller').set(auth(await cliToken(h, ['rates:read'])));
        expect(res.status).toBe(200);
        expect(res.body.audience).toBe('cli');
        expect(res.body.tokenId).toEqual(expect.any(String));
        expect(res.body.permissions).toEqual(['rates:read']);
    });
});

describe('requireHostToken', () => {
    it('host token only refuses session and cli token', async () => {
        const h = await start();
        for (const bearer of [await session(h), await cliToken(h)]) {
            const res = await request(h.cli.app).get('/host/only').set(auth(bearer));
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ error: HOST_ONLY });
        }
        const ok = await request(h.cli.app).get('/host/only').set(auth((await hostToken(h)).token));
        expect(ok.status).toBe(200);
        expect(ok.body.audience).toBe('host');
    });

    it('host token only checks the audience first', async () => {
        const h = await start();
        // a cli token without the permission: the audience text, not the permission text
        const cli = await request(h.cli.app).get('/host/only').set(auth(await cliToken(h, ['banks:read'])));
        expect(cli.status).toBe(403);
        expect(cli.body).toEqual({ error: HOST_ONLY });

        // a host token whose owner lost the permission
        const { token } = await hostToken(h);
        await h.plugin.groupStore.updateGroup(h.groupName, { permissions: ['banks:read'] });
        const lost = await request(h.cli.app).get('/host/only').set(auth(token));
        expect(lost.status).toBe(403);
        expect(lost.body).toEqual({ error: 'forbidden: missing permission rates:read' });
    });

    it('authentication answers first, with the existing texts', async () => {
        const h = await start();
        const none = await request(h.cli.app).get('/host/only');
        expect(none.status).toBe(401);
        expect(none.body).toEqual({ error: 'unauthorized' });
        const unknown = await request(h.cli.app).get('/host/only').set(auth('qcli_pat_unknown'));
        expect(unknown.status).toBe(401);
        expect(unknown.body).toEqual({ error: 'invalid or expired token' });
    });

    it('requirePermission unchanged for cli tokens and sessions', async () => {
        const h = await start();
        for (const bearer of [await session(h), await cliToken(h)]) {
            const res = await request(h.cli.app).get('/host/caller').set(auth(bearer));
            expect(res.status).toBe(200);
        }
        const denied = await request(h.cli.app).get('/host/caller').set(auth(await cliToken(h, ['banks:read'])));
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: 'forbidden: missing permission rates:read' });
    });
});
