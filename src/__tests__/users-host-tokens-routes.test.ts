/**
 * Host tokens on a protected server: refused only on the CLI's own routes (what the
 * server and its plugins mount, the sockets included); on any other path, `/api/...`
 * too, the host's own guard decides. Plus the fail-closed audience reading, the
 * manager's user-id check and the shell's 4403 close texts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliEchoCommandProcessor } from '../processors/cli-echo-command-processor';
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

async function start(options: UsersModuleOptions = {}, userPermissions = ['*']): Promise<Harness> {
    const cli = createCliServer({ enableShell: true, shell: { sessionCheckIntervalMs: 60_000 }, configure: (b) => b.addProcessor(new CliEchoCommandProcessor()) });
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
    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(server);
    cli.logSocketManager.attach(server);
    const h = { cli, plugin, admin, server, port: (server.address() as AddressInfo).port, userId: user.id, groupName };
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
