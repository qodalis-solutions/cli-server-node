/**
 * `host` tokens (created by the host through `usersPlugin.apiTokens`): refused with 403
 * on every CLI route, whatever it requires, and accepted only by the host's guards
 * (`requireAuth` / `requirePermission`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliEchoCommandProcessor } from '../processors/cli-echo-command-processor';
import { CliUsersBuilder, UsersModuleOptions, UsersPluginResult } from '../../plugins/users/index';
import { BASE, ROOT_PASS, auth, login } from './users-test-helpers';

const HOST_TEXT = 'forbidden: host tokens cannot use CLI routes';

let plugins: UsersPluginResult[] = [];

afterEach(() => {
    for (const p of plugins) p.dispose();
    plugins = [];
});

interface Harness {
    cli: CliServerResult;
    plugin: UsersPluginResult;
    userId: string;
    groupName: string;
}

async function start(options: UsersModuleOptions = {}, userPermissions = ['*']): Promise<Harness> {
    const cli = createCliServer({ mcp: true, configure: (b) => b.addProcessor(new CliEchoCommandProcessor()) });
    cli.builder.addPermissions([
        { name: 'rates:read', description: 'Official exchange rates', group: 'Rates' },
        { name: 'banks:read', description: 'Banks and their buy and sell rates', group: 'Rates' },
    ]);
    const plugin = new CliUsersBuilder()
        .setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4, ipRateLimit: 10_000, ...options })
        .build();
    plugins.push(plugin);
    cli.mountPlugin(plugin);
    await plugin.ready;
    cli.app.get('/host/rates', plugin.requirePermission('rates:read'), (req, res) => {
        res.json({ user: req.qcliAuth?.user.name, rates: [] });
    });
    cli.app.get('/host/me', plugin.requireAuth(), (req, res) => {
        res.json({ user: req.qcliAuth?.user.name });
    });
    const groupName = 'customers';
    await plugin.groupStore.createGroup({ name: groupName, permissions: userPermissions });
    const user = await plugin.userStore.createUser({ name: 'alice', email: 'alice@example.com', groups: [groupName] });
    return { cli, plugin, userId: user.id, groupName };
}

const execBody = { command: 'echo', value: 'hi', chainCommands: [], args: {}, rawCommand: 'echo hi' };

/** Every CLI route probed with the token: all answer 403 with the host-token text. */
async function expectRefusedEverywhere(app: express.Express, token: string): Promise<void> {
    const probes: [string, request.Test][] = [
        ['POST /execute', request(app).post(`${BASE}/execute`).send(execBody)],
        ['POST /api/qcli/execute', request(app).post('/api/qcli/execute').send(execBody)],
        ['GET /commands', request(app).get(`${BASE}/commands`)],
        ['GET /tokens', request(app).get(`${BASE}/tokens`)],
        ['POST /tokens', request(app).post(`${BASE}/tokens`).send({ name: 'x' })],
        ['GET /permissions', request(app).get(`${BASE}/permissions`)],
        ['GET /sessions/current', request(app).get(`${BASE}/sessions/current`)],
        ['POST /sessions/ws-ticket', request(app).post(`${BASE}/sessions/ws-ticket`)],
        ['GET /users', request(app).get(`${BASE}/users`)],
        ['GET /groups', request(app).get(`${BASE}/groups`)],
        ['GET /audit', request(app).get(`${BASE}/audit`)],
        [
            'POST /api/qcli/mcp',
            request(app)
                .post('/api/qcli/mcp')
                .set('Content-Type', 'application/json')
                .set('Accept', 'application/json, text/event-stream')
                .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })),
        ],
    ];
    for (const [name, probe] of probes) {
        const res = await probe.set(auth(token));
        expect(res.status, name).toBe(403);
        expect(res.body, name).toEqual({ error: HOST_TEXT });
    }
}

describe('host tokens', () => {
    it('are refused on every CLI route and accepted by the host guards', async () => {
        const h = await start();
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'api', audience: 'host', permissions: ['rates:read'] });
        await expectRefusedEverywhere(h.cli.app, token);

        const rates = await request(h.cli.app).get('/host/rates').set(auth(token));
        expect(rates.status).toBe(200);
        expect(rates.body.user).toBe('alice');
        const me = await request(h.cli.app).get('/host/me').set(auth(token));
        expect(me.status).toBe(200);
        expect(me.body).toEqual({ user: 'alice' });
    });

    it('the guard checks the token scope with its existing text', async () => {
        const h = await start();
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'api', audience: 'host', permissions: ['banks:read'] });
        const res = await request(h.cli.app).get('/host/rates').set(auth(token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden: missing permission rates:read' });
    });

    it('with the permission removed from the user: the guard says missing permission, CLI routes still say host token', async () => {
        const h = await start({}, ['rates:read', 'commands:execute']);
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'api', audience: 'host', permissions: ['rates:read'] });
        expect((await request(h.cli.app).get('/host/rates').set(auth(token))).status).toBe(200);
        await h.plugin.groupStore.updateGroup(h.groupName, { permissions: [] });
        const res = await request(h.cli.app).get('/host/rates').set(auth(token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden: missing permission rates:read' });
        // live permissions are empty: the CLI routes still refuse the token as a host token
        await expectRefusedEverywhere(h.cli.app, token);
    });

    it('is refused before the password-change check', async () => {
        const h = await start();
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'api', audience: 'host', permissions: ['rates:read'] });
        await h.plugin.userStore.updateUser(h.userId, { mustChangePassword: true });
        const res = await request(h.cli.app).get(`${BASE}/sessions/current`).set(auth(token));
        expect(res.body).toEqual({ error: HOST_TEXT });
        expect((await request(h.cli.app).get(`${BASE}/commands`).set(auth(token))).body).toEqual({ error: HOST_TEXT });
    });

    it('cli tokens and sessions are not affected', async () => {
        const h = await start();
        const cliToken = await h.plugin.apiTokens.create(h.userId, { name: 'cli' });
        expect((await request(h.cli.app).get(`${BASE}/commands`).set(auth(cliToken.token))).status).toBe(200);
        expect((await request(h.cli.app).get('/host/rates').set(auth(cliToken.token))).status).toBe(200);
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        expect((await request(h.cli.app).get(`${BASE}/commands`).set(auth(root.token))).status).toBe(200);
        expect((await request(h.cli.app).get('/host/me').set(auth(root.token))).status).toBe(200);
    });

    it('the admin dashboard provider and socket re-checks refuse host tokens', async () => {
        const h = await start();
        const { token, apiToken } = await h.plugin.apiTokens.create(h.userId, { name: 'api', audience: 'host', permissions: ['rates:read'] });
        await expect(h.plugin.serverAuth.authenticateToken(token)).rejects.toMatchObject({ status: 403, message: HOST_TEXT });
        const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET' } as any;
        await expect(h.plugin.serverAuth.authenticateRequest(req)).rejects.toMatchObject({ status: 403, message: HOST_TEXT });
        expect(await h.plugin.serverAuth.revalidate({ userId: h.userId, userName: 'alice', tokenId: apiToken.id, permissions: [] })).toBeUndefined();

        const cliToken = await h.plugin.apiTokens.create(h.userId, { name: 'cli' });
        expect(await h.plugin.serverAuth.revalidate({ userId: h.userId, userName: 'alice', tokenId: cliToken.apiToken.id, permissions: [] })).toBeDefined();
        expect((await h.plugin.serverAuth.authenticateToken(cliToken.token)).userName).toBe('alice');
    });

    it('HostToken_GuardDoesNotConsultTheCatalog: the guard checks live permissions only', async () => {
        const h = await start();
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'api', audience: 'host', permissions: ['rates:read'] });
        const catalog = h.plugin.authService.permissionCatalog();
        const find = vi.spyOn(catalog, 'find');
        const all = vi.spyOn(catalog, 'all');
        expect((await request(h.cli.app).get('/host/rates').set(auth(token))).status).toBe(200);
        expect((await request(h.cli.app).get('/host/me').set(auth(token))).status).toBe(200);
        expect(find).not.toHaveBeenCalled();
        expect(all).not.toHaveBeenCalled();
    });

    it('with an external auth adapter and API tokens: CLI routes refuse, the host route admits', async () => {
        let plugin: UsersPluginResult | undefined;
        const h = await start({
            authAdapter: async (req) => {
                const name = req.headers['x-user'];
                const user = typeof name === 'string' && name ? await plugin!.userStore.getUser(name) : undefined;
                return user ? { user } : null;
            },
            apiTokensWithExternalAuth: true,
        });
        plugin = h.plugin;
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'api', audience: 'host', permissions: ['rates:read'] });
        for (const path of [`${BASE}/commands`, `${BASE}/tokens`, `${BASE}/permissions`]) {
            const res = await request(h.cli.app).get(path).set(auth(token));
            expect(res.status, path).toBe(403);
            expect(res.body, path).toEqual({ error: HOST_TEXT });
        }
        const ok = await request(h.cli.app).get('/host/rates').set(auth(token));
        expect(ok.status).toBe(200);
        expect(ok.body.user).toBe('alice');
        // the adapter's users keep working on CLI routes
        expect((await request(h.cli.app).get(`${BASE}/commands`).set('X-User', 'alice')).status).toBe(200);
    });

    it('when the server is not protected, a host token on a CLI route grants nothing more than no token', async () => {
        const h = await start({ protectServer: false });
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'api', audience: 'host', permissions: ['rates:read'] });
        expect((await request(h.cli.app).get(`${BASE}/commands`).set(auth(token))).status).toBe(200);
        // the users plugin's own routes still authenticate, and refuse it
        expect((await request(h.cli.app).get(`${BASE}/tokens`).set(auth(token))).body).toEqual({ error: HOST_TEXT });
    });
});
