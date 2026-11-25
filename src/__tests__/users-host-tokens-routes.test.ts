/**
 * Host tokens on a protected server: refused only on the CLI's own routes (what the
 * server and its plugins mount, the sockets included); on any other path, `/api/...`
 * too, the host's own guard decides. Plus the fail-closed audience reading, the
 * manager's user-id check and the shell's 4403 close texts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Router } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliEchoCommandProcessor } from '../../demo/src/processors/cli-echo-command-processor';
import { CliUsersBuilder, InMemoryApiTokenStore, UsersModuleOptions, UsersPluginResult } from '../../plugins/users/index';
import type { ApiToken, ICliApiTokenStore } from '../../plugins/users/index';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';
import { BASE, ROOT_PASS, auth, login } from './users-test-helpers';

const HOST_TEXT = 'forbidden: host tokens cannot use CLI routes';

interface Harness {
    cli: CliServerResult;
    plugin: UsersPluginResult;
    admin: CliAdminPluginResult;
    server: http.Server;
    port: number;
    userId: string;
    groupName: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
    while (harnesses.length) {
        const h = harnesses.pop()!;
        h.admin.dispose();
        h.plugin.dispose();
        h.cli.eventSocketManager.dispose();
        h.cli.logSocketManager.dispose();
        h.server.closeAllConnections?.();
        await new Promise<void>((r) => h.server.close(() => r()));
    }
});

async function start(options: UsersModuleOptions = {}, userPermissions = ['*'], server: { mcp?: boolean } = {}): Promise<Harness> {
    const cli = createCliServer({
        enableShell: true,
        mcp: server.mcp,
        shell: { sessionCheckIntervalMs: 60_000 },
        configure: (b) => b.addProcessor(new CliEchoCommandProcessor()),
    });
    cli.builder.addPermissions([
        { name: 'rates:read', description: 'Official exchange rates', group: 'Rates' },
        { name: 'banks:read', description: 'Banks and their buy and sell rates', group: 'Rates' },
    ]);
    const plugin = new CliUsersBuilder()
        .setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4, ipRateLimit: 10_000, ...options })
        .build();
    await plugin.ready;
    const admin = new CliAdminBuilder()
        .setCredentials('dashadmin', 'dashpass')
        .setJwtSecret('test-secret')
        .setAuthProvider(plugin.serverAuth)
        .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
    admin.logBuffer.restoreConsole();
    cli.mountPlugin(admin);
    cli.mountPlugin(plugin);
    // The host's own API, under /api like the CLI's
    cli.app.get('/api/rates', plugin.requirePermission('rates:read'), (req, res) => {
        res.json({ user: req.qcliAuth?.user.name, rates: [] });
    });
    const groupName = 'customers';
    await plugin.groupStore.createGroup({ name: groupName, permissions: userPermissions });
    const user = await plugin.userStore.createUser({ name: 'alice', email: 'alice@example.com', groups: [groupName] });
    const httpServer = http.createServer(cli.app);
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(httpServer);
    cli.logSocketManager.attach(httpServer);
    const h = { cli, plugin, admin, server: httpServer, port: (httpServer.address() as AddressInfo).port, userId: user.id, groupName };
    harnesses.push(h);
    return h;
}

/** Opens a socket; resolves with its close code and reason, or the HTTP status of a rejected upgrade. */
function socketOutcome(port: number, path: string, headers: Record<string, string> = {}): Promise<{ code?: number; reason?: string; status?: number }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on('unexpected-response', (_req, res) => {
            resolve({ status: res.statusCode });
            res.resume();
            ws.terminate();
        });
        ws.on('error', () => undefined);
    });
}

describe('host tokens on host routes under /api', () => {
    it('the host guard decides: 200 with the permission, its own 403 without', async () => {
        const h = await start();
        const withRates = await h.plugin.apiTokens.create(h.userId, { name: 'rates', audience: 'host', permissions: ['rates:read'] });
        const ok = await request(h.cli.app).get('/api/rates').set(auth(withRates.token));
        expect(ok.status).toBe(200);
        expect(ok.body.user).toBe('alice');

        const banksOnly = await h.plugin.apiTokens.create(h.userId, { name: 'banks', audience: 'host', permissions: ['banks:read'] });
        const denied = await request(h.cli.app).get('/api/rates').set(auth(banksOnly.token));
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: 'forbidden: missing permission rates:read' });
    });

    it('the same token is refused on the CLI routes, the admin API and the sockets', async () => {
        const h = await start();
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'rates', audience: 'host', permissions: ['rates:read'] });
        for (const path of [`${BASE}/commands`, `${BASE}/tokens`, `${BASE}/status`, `${BASE}/plugins`, '/api/qcli/commands', '/api/qcli/fs/ls']) {
            const res = await request(h.cli.app).get(path).set(auth(token));
            expect(res.status, path).toBe(403);
            expect(res.body, path).toEqual({ error: HOST_TEXT });
        }
        const exec = await request(h.cli.app).post(`${BASE}/execute`).set(auth(token)).send({ command: 'echo', value: 'hi', chainCommands: [], args: {} });
        expect(exec.body).toEqual({ error: HOST_TEXT });

        const header = { Authorization: `Bearer ${token}` };
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', header)).toEqual({ code: 4403, reason: HOST_TEXT });
        expect(await socketOutcome(h.port, '/ws/qcli/shell', header)).toEqual({ code: 4403, reason: HOST_TEXT });
        // the events and logs sockets refuse the upgrade itself (HTTP 403)
        expect(await socketOutcome(h.port, '/ws/v1/qcli/events', header)).toEqual({ status: 403 });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/logs', header)).toEqual({ status: 403 });
    });

    it('cli tokens, sessions and anonymous requests behave as before on /api/rates and the sockets', async () => {
        const h = await start();
        const cliToken = await h.plugin.apiTokens.create(h.userId, { name: 'cli', permissions: ['rates:read'] });
        expect((await request(h.cli.app).get('/api/rates').set(auth(cliToken.token))).status).toBe(200);
        const noRates = await h.plugin.apiTokens.create(h.userId, { name: 'cli2', permissions: ['commands:execute'] });
        const denied = await request(h.cli.app).get('/api/rates').set(auth(noRates.token));
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: 'forbidden: missing permission rates:read' });

        const root = await login(h.cli.app, 'root', ROOT_PASS);
        expect((await request(h.cli.app).get('/api/rates').set(auth(root.token))).status).toBe(200);
        const anonymous = await request(h.cli.app).get('/api/rates');
        expect(anonymous.status).toBe(401);
        expect(anonymous.body).toEqual({ error: 'unauthorized' });
        const bad = await request(h.cli.app).get('/api/rates').set(auth('qcli_pat_nope'));
        expect(bad.status).toBe(401);

        // a bearer on the socket upgrade is still not a ticket
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', { Authorization: `Bearer ${cliToken.token}` })).toEqual({
            code: 4401,
            reason: 'login required',
        });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/events', { Authorization: `Bearer ${root.token}` })).toEqual({ status: 401 });
    });

    it('the shell closes 4403 with the plugin text when a ticket is refused (password change required)', async () => {
        const h = await start();
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        const ticket = (await request(h.cli.app).post(`${BASE}/sessions/ws-ticket`).set(auth(root.token)).expect(201)).body.ticket;
        await h.plugin.userStore.updateUser(root.userId, { mustChangePassword: true });
        expect(await socketOutcome(h.port, `/ws/v1/qcli/shell?ticket=${ticket}`)).toEqual({ code: 4403, reason: 'password change required' });
    });
});

describe('fail-closed audience', () => {
    async function startWithStoredAudience(audience: unknown) {
        const inner = new InMemoryApiTokenStore();
        const rewrite = (t: ApiToken | undefined) => (t ? ({ ...t, audience } as unknown as ApiToken) : t);
        const store: ICliApiTokenStore = {
            createToken: async (t) => rewrite(await inner.createToken(t))!,
            getTokenByHash: async (hash) => rewrite(await inner.getTokenByHash(hash)),
            getToken: async (id) => rewrite(await inner.getToken(id)),
            getTokens: async (userId) => (await inner.getTokens(userId)).map((t) => rewrite(t)!),
            deleteToken: (id) => inner.deleteToken(id),
            deleteUserTokens: (userId) => inner.deleteUserTokens(userId),
            updateLastUsed: (id, at) => inner.updateLastUsed(id, at),
        };
        return start({ apiTokenStore: store });
    }

    it('a stored audience that is not exactly cli counts as a host token', async () => {
        for (const audience of ['HOST', 'api', 'Cli']) {
            const h = await startWithStoredAudience(audience);
            const { token, apiToken } = await h.plugin.apiTokens.create(h.userId, { name: 't', permissions: ['rates:read'] });
            expect(apiToken.audience, audience).toBe('host');
            const res = await request(h.cli.app).get(`${BASE}/commands`).set(auth(token));
            expect(res.status, audience).toBe(403);
            expect(res.body, audience).toEqual({ error: HOST_TEXT });
            expect((await request(h.cli.app).get(`${BASE}/tokens`).set(auth(token))).body).toEqual({ error: HOST_TEXT });
            // the host guard still accepts it and checks its permissions
            expect((await request(h.cli.app).get('/api/rates').set(auth(token))).status, audience).toBe(200);
        }
    });

    it('null and empty stored audiences read as cli', async () => {
        for (const audience of [null, '']) {
            const h = await startWithStoredAudience(audience);
            const { token, apiToken } = await h.plugin.apiTokens.create(h.userId, { name: 't' });
            expect(apiToken.audience).toBe('cli');
            expect((await request(h.cli.app).get(`${BASE}/commands`).set(auth(token))).status).toBe(200);
        }
    });
});

describe('ApiTokenManager: user id required', () => {
    it('every method rejects a null, undefined or empty user id before touching the store', async () => {
        const h = await start();
        const other = await h.plugin.apiTokens.create(h.userId, { name: 'keep' });
        const store = h.plugin.apiTokenStore;
        const spies = [
            vi.spyOn(store, 'getTokens'),
            vi.spyOn(store, 'getToken'),
            vi.spyOn(store, 'deleteToken'),
            vi.spyOn(store, 'createToken'),
            vi.spyOn(h.plugin.userStore, 'getUser'),
        ];
        for (const id of [null, undefined, ''] as unknown as string[]) {
            await expect(h.plugin.apiTokens.create(id, { name: 'x' })).rejects.toBeInstanceOf(TypeError);
            await expect(h.plugin.apiTokens.list(id)).rejects.toBeInstanceOf(TypeError);
            await expect(h.plugin.apiTokens.revoke(id, other.apiToken.id)).rejects.toBeInstanceOf(TypeError);
            await expect(h.plugin.apiTokens.grantablePermissions(id)).rejects.toBeInstanceOf(TypeError);
        }
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        expect(await h.plugin.apiTokenStore.getToken(other.apiToken.id)).toBeDefined();
    });
});

describe('shell close reasons', () => {
    it('keep the provider text up to 123 UTF-8 bytes, else forbidden', async () => {
        const { closeReason } = await import('../services/cli-shell-session-manager');
        expect(closeReason(HOST_TEXT)).toBe(HOST_TEXT);
        expect(closeReason('x'.repeat(123))).toBe('x'.repeat(123));
        expect(closeReason('x'.repeat(124))).toBe('forbidden');
        expect(closeReason('é'.repeat(62))).toBe('forbidden');
        expect(closeReason(undefined)).toBe('forbidden');
        expect(closeReason('')).toBe('forbidden');
    });
});

describe('socket probe of a qcli_pat_ bearer', () => {
    it('reads the token store only: lastUsedAt is not written', async () => {
        const h = await start();
        const host = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        const cli = await h.plugin.apiTokens.create(h.userId, { name: 'cli' });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', { Authorization: `Bearer ${host.token}` })).toEqual({ code: 4403, reason: HOST_TEXT });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/events', { Authorization: `Bearer ${host.token}` })).toEqual({ status: 403 });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', { Authorization: `Bearer ${cli.token}` })).toEqual({ code: 4401, reason: 'login required' });
        expect((await h.plugin.apiTokenStore.getToken(host.apiToken.id))!.lastUsedAt).toBeUndefined();
        expect((await h.plugin.apiTokenStore.getToken(cli.apiToken.id))!.lastUsedAt).toBeUndefined();
    });

    it('never calls the external auth adapter', async () => {
        const adapter = vi.fn(() => null);
        const h = await start({ authAdapter: adapter });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', { Authorization: 'Bearer qcli_pat_anything' })).toEqual({ code: 4401, reason: 'login required' });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/events', { Authorization: 'Bearer qcli_pat_anything' })).toEqual({ status: 401 });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('with API tokens next to the adapter: host tokens are told apart from the store, the adapter is not called', async () => {
        const adapter = vi.fn(() => null);
        const h = await start({ authAdapter: adapter, apiTokensWithExternalAuth: true });
        const host = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', { Authorization: `Bearer ${host.token}` })).toEqual({ code: 4403, reason: HOST_TEXT });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', { Authorization: 'Bearer qcli_pat_unknown' })).toEqual({ code: 4401, reason: 'login required' });
        expect(adapter).not.toHaveBeenCalled();
        expect((await h.plugin.apiTokenStore.getToken(host.apiToken.id))!.lastUsedAt).toBeUndefined();
    });
});

describe('host tokens on an unguarded host route under /api', () => {
    const openRoute = (h: Harness) =>
        h.cli.app.get('/api/open', (req, res) => {
            res.json({ serverAuth: req.qcliServerAuth ?? null, qcliAuth: req.qcliAuth ?? null, hostToken: req.qcliHostToken ?? null });
        });

    it('reaches the route unauthenticated, marked as a host token', async () => {
        const h = await start();
        openRoute(h);
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        const res = await request(h.cli.app).get('/api/open').set(auth(token));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ serverAuth: null, qcliAuth: null, hostToken: true });

        // the same for a host token whose user must change their password
        await h.plugin.userStore.updateUser(h.userId, { mustChangePassword: true });
        const pending = await request(h.cli.app).get('/api/open').set(auth(token));
        expect(pending.status).toBe(200);
        expect(pending.body).toEqual({ serverAuth: null, qcliAuth: null, hostToken: true });
    });

    it('cli tokens and sessions are authenticated by the gate and not marked', async () => {
        const h = await start();
        openRoute(h);
        const cli = await h.plugin.apiTokens.create(h.userId, { name: 'cli' });
        const res = await request(h.cli.app).get('/api/open').set(auth(cli.token));
        expect(res.status).toBe(200);
        expect(res.body.hostToken).toBeNull();
        expect(res.body.serverAuth).toMatchObject({ userName: 'alice', tokenId: cli.apiToken.id });
        expect((await request(h.cli.app).get('/api/open')).status).toBe(401);
    });
});

describe('path variants with a host token', () => {
    it('every spelling of a CLI route is refused with the host-token text', async () => {
        const h = await start({}, ['*'], { mcp: true });
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        for (const path of ['/API/V1/QCLI/commands', '//api/v1/qcli/commands', '/api/v1/qcli/commands/', '/api/v1/qcli//commands']) {
            const res = await request(h.cli.app).get(path).set(auth(token));
            expect(res.status, path).toBe(403);
            expect(res.body, path).toEqual({ error: HOST_TEXT });
        }
        for (const path of ['/api/qcli/mcp/', '/API/QCLI/MCP']) {
            const res = await request(h.cli.app)
                .post(path)
                .set(auth(token))
                .set('Content-Type', 'application/json')
                .set('Accept', 'application/json, text/event-stream')
                .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
            expect(res.status, path).toBe(403);
            expect(res.body, path).toEqual({ error: HOST_TEXT });
        }
    });

    it('a plugin mounted at a non-default /api prefix is a CLI route; a sibling host route is not', async () => {
        const h = await start();
        const router = Router();
        router.get('/items', (_req, res) => res.json({ items: [] }));
        h.cli.mountPlugin({ prefix: '/api/custom', router });
        h.cli.app.get('/api/customers', h.plugin.requireAuth(), (req, res) => res.json({ user: req.qcliAuth?.user.name }));
        const { token } = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });

        for (const path of ['/api/custom/items', '/API/Custom/items/', '/api/custom']) {
            const res = await request(h.cli.app).get(path).set(auth(token));
            expect(res.status, path).toBe(403);
            expect(res.body, path).toEqual({ error: HOST_TEXT });
        }
        const sibling = await request(h.cli.app).get('/api/customers').set(auth(token));
        expect(sibling.status).toBe(200);
        expect(sibling.body).toEqual({ user: 'alice' });
        // a session still reaches the plugin
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        expect((await request(h.cli.app).get('/api/custom/items').set(auth(root.token))).status).toBe(200);
    });
});

describe('host tokens on an unprotected server', () => {
    const MCP_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const probes = (app: Harness['cli']['app']): [string, () => request.Test][] => [
        ['GET /commands', () => request(app).get(`${BASE}/commands`)],
        ['POST /execute', () => request(app).post(`${BASE}/execute`).send({ command: 'echo', value: 'hi', chainCommands: [], args: {} })],
        ['GET /api/qcli/fs/ls', () => request(app).get('/api/qcli/fs/ls?path=/')],
        ['GET /api/qcli/data-explorer/sources', () => request(app).get('/api/qcli/data-explorer/sources')],
        ['GET /jobs', () => request(app).get(`${BASE}/jobs`)],
        [
            'POST /api/qcli/mcp',
            () =>
                request(app)
                    .post('/api/qcli/mcp')
                    .set('Content-Type', 'application/json')
                    .set('Accept', 'application/json, text/event-stream')
                    .send(MCP_BODY),
        ],
    ];

    it('a host token is refused on the CLI routes and sockets; anonymous and cli-token requests are unchanged', async () => {
        const h = await start({ protectServer: false }, ['*'], { mcp: true });
        const host = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        const cli = await h.plugin.apiTokens.create(h.userId, { name: 'cli' });
        for (const [name, probe] of probes(h.cli.app)) {
            const refused = await probe().set(auth(host.token));
            expect(refused.status, name).toBe(403);
            expect(refused.body, name).toEqual({ error: HOST_TEXT });
            const anonymous = await probe();
            expect(anonymous.status, name).not.toBe(403);
            const withCli = await probe().set(auth(cli.token));
            expect(withCli.status, name).toBe(anonymous.status);
        }
        expect((await request(h.cli.app).get(`${BASE}/commands`)).status).toBe(200);

        const header = { Authorization: `Bearer ${host.token}` };
        expect(await socketOutcome(h.port, '/ws/v1/qcli/events', header)).toEqual({ status: 403 });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/logs', header)).toEqual({ status: 403 });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', header)).toEqual({ code: 4403, reason: HOST_TEXT });

        // the host's own route under /api still works with the host token
        const rates = await request(h.cli.app).get('/api/rates').set(auth(host.token));
        expect(rates.status).toBe(200);
        expect(rates.body.user).toBe('alice');
        expect((await request(h.cli.app).get('/api/rates').set(auth(cli.token))).status).toBe(200);
    });

    it('the events socket still opens anonymously and with a cli-token bearer', async () => {
        const h = await start({ protectServer: false });
        const cli = await h.plugin.apiTokens.create(h.userId, { name: 'cli' });
        const open = (headers: Record<string, string>) =>
            new Promise<string>((resolve) => {
                const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/v1/qcli/events`, { headers });
                ws.on('open', () => {
                    ws.close();
                    resolve('open');
                });
                ws.on('unexpected-response', (_req, res) => resolve(`status ${res.statusCode}`));
                ws.on('error', () => undefined);
            });
        expect(await open({})).toBe('open');
        expect(await open({ Authorization: `Bearer ${cli.token}` })).toBe('open');
    });
});

describe('the Bearer scheme is matched like the authenticator does (case-sensitive)', () => {
    it('a host token sent as `bearer …` is no credential anywhere: not a host token, not authenticated', async () => {
        const h = await start();
        const host = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        const lower = { Authorization: `bearer ${host.token}` };
        const commands = await request(h.cli.app).get(`${BASE}/commands`).set(lower);
        expect(commands.status).toBe(401);
        expect(commands.body).toEqual({ error: 'unauthorized' });
        expect((await request(h.cli.app).get('/api/rates').set(lower)).status).toBe(401);
        expect(await socketOutcome(h.port, '/ws/v1/qcli/shell', lower)).toEqual({ code: 4401, reason: 'login required' });
        expect(await socketOutcome(h.port, '/ws/v1/qcli/events', lower)).toEqual({ status: 401 });
        // the exact scheme is refused as a host token
        expect((await request(h.cli.app).get(`${BASE}/commands`).set(auth(host.token))).body).toEqual({ error: HOST_TEXT });
    });

    it('on an unprotected server a `bearer …` host token is treated like no token', async () => {
        const h = await start({ protectServer: false });
        const host = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        const lower = { Authorization: `bearer ${host.token}` };
        expect((await request(h.cli.app).get(`${BASE}/commands`).set(lower)).status).toBe((await request(h.cli.app).get(`${BASE}/commands`)).status);
        expect((await request(h.cli.app).get(`${BASE}/tokens`).set(lower)).status).toBe(401);
    });
});

describe('public CLI routes are not checked for host tokens on an unprotected server', () => {
    it('versions, capabilities, sign-in and link answer exactly as without the bearer; the other CLI routes refuse', async () => {
        const h = await start({ protectServer: false });
        const host = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        const withHost = (t: request.Test) => t.set(auth(host.token));
        const same = async (name: string, make: () => request.Test, compareBody = true) => {
            const plain = await make();
            const bearer = await withHost(make());
            expect(bearer.status, name).toBe(plain.status);
            expect(bearer.status, name).not.toBe(403);
            if (compareBody) expect(bearer.body, name).toEqual(plain.body);
            else expect(Object.keys(bearer.body).sort(), name).toEqual(Object.keys(plain.body).sort());
        };
        await same('GET /api/qcli/versions', () => request(h.cli.app).get('/api/qcli/versions'));
        await same('GET /api/v1/qcli/version', () => request(h.cli.app).get(`${BASE}/version`));
        await same('GET /api/v1/qcli/capabilities', () => request(h.cli.app).get(`${BASE}/capabilities`));
        await same('POST /sessions (wrong password)', () => request(h.cli.app).post(`${BASE}/sessions`).send({ username: 'root', password: 'nope' }));
        await same('POST /sessions', () => request(h.cli.app).post(`${BASE}/sessions`).send({ username: 'root', password: ROOT_PASS }), false);
        await same('POST /link', () => request(h.cli.app).post(`${BASE}/link`).send({ client: 'tests' }), false);
        await same('GET /link/:id', () => request(h.cli.app).get(`${BASE}/link/unknown-link-id`));

        for (const path of [`${BASE}/commands`, `${BASE}/tokens`, `${BASE}/sessions/current`]) {
            const res = await withHost(request(h.cli.app).get(path));
            expect(res.status, path).toBe(403);
            expect(res.body, path).toEqual({ error: HOST_TEXT });
        }
    });

    it('the protected server treats the same public routes the same way', async () => {
        const h = await start();
        const host = await h.plugin.apiTokens.create(h.userId, { name: 'host', audience: 'host', permissions: ['rates:read'] });
        expect((await request(h.cli.app).get('/api/qcli/versions').set(auth(host.token))).status).toBe(200);
        expect((await request(h.cli.app).post(`${BASE}/sessions`).set(auth(host.token)).send({ username: 'root', password: ROOT_PASS })).status).toBe(201);
        expect((await request(h.cli.app).post(`${BASE}/link`).set(auth(host.token)).send({ client: 'tests' })).status).toBe(201);
    });
});
