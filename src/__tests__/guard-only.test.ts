/**
 * A second service that only validates tokens: `createCliServer({ cliRoutes: false })`
 * serves none of the CLI's routes or sockets, and a guard-only users plugin serves no
 * routes and seeds nothing, while its guards accept the tokens of the shared stores.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { Router } from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliEchoCommandProcessor } from '../processors/cli-echo-command-processor';
import {
    CliUsersBuilder,
    InMemoryApiTokenStore,
    InMemoryGroupStore,
    InMemoryUserStore,
    UsersPluginResult,
} from '../../plugins/users/index';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { CliAdminBuilder } from '../../plugins/admin';
import { CliPublicApiBuilder } from '@qodalis/cli-server-plugin-public-api';
import { ROOT_PASS, auth } from './users-test-helpers';

const RATES = [{ name: 'rates:read', description: 'Official exchange rates', group: 'Rates' }];

const disposables: Array<() => void> = [];

afterEach(() => {
    vi.restoreAllMocks();
    while (disposables.length) disposables.pop()!();
});

function track(cli: CliServerResult, plugin?: UsersPluginResult): void {
    disposables.push(() => {
        plugin?.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
}

interface Pair {
    main: CliServerResult;
    guard: CliServerResult;
    guardUsers: UsersPluginResult;
    hostToken: string;
    stores: { userStore: InMemoryUserStore; groupStore: InMemoryGroupStore; apiTokenStore: InMemoryApiTokenStore };
}

/** A normal server that created alice's host token, and a guard-only one over the same stores. */
async function startPair(): Promise<Pair> {
    const stores = {
        userStore: new InMemoryUserStore(),
        groupStore: new InMemoryGroupStore(),
        apiTokenStore: new InMemoryApiTokenStore(),
    };
    const main = createCliServer({ configure: (b) => b.addProcessor(new CliEchoCommandProcessor()) });
    main.builder.addPermissions(RATES);
    const mainUsers = new CliUsersBuilder()
        .setOptions({ ...stores, defaultAdminPassword: ROOT_PASS, minPasswordLength: 4 })
        .build();
    await mainUsers.ready;
    main.mountPlugin(mainUsers);
    track(main, mainUsers);
    await stores.groupStore.createGroup({ name: 'customers', permissions: ['rates:read'] });
    const alice = await stores.userStore.createUser({ name: 'alice', email: 'alice@example.com', groups: ['customers'] });
    const { token } = await mainUsers.apiTokens.create(alice.id, { name: 'site', audience: 'host', permissions: ['rates:read'] });

    const guard = createCliServer({ cliRoutes: false, configure: (b) => b.addProcessor(new CliEchoCommandProcessor()) });
    guard.builder.addPermissions(RATES);
    const guardUsers = new CliUsersBuilder().setOptions(stores).setGuardOnly().build();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    guard.mountPlugin(guardUsers);
    track(guard, guardUsers);
    guard.app.get('/host/rates', guardUsers.requireHostToken('rates:read'), (req, res) => {
        res.json({ user: req.qcliCaller?.userName });
    });
    return { main, guard, guardUsers, hostToken: token, stores };
}

describe('guard-only users plugin on a server without CLI routes', () => {
    it('host route accepts the host token', async () => {
        const p = await startPair();
        const res = await request(p.guard.app).get('/host/rates').set(auth(p.hostToken));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ user: 'alice' });
        const none = await request(p.guard.app).get('/host/rates');
        expect(none.status).toBe(401);
    });

    it.each([
        ['GET', '/api/v1/qcli/commands'],
        ['POST', '/api/v1/qcli/execute'],
        ['POST', '/api/v1/qcli/auth/login'],
        ['POST', '/api/v1/qcli/sessions'],
        ['GET', '/api/v1/qcli/tokens'],
        ['GET', '/api/v1/qcli/permissions'],
        ['GET', '/api/v1/qcli/audit'],
        ['GET', '/api/qcli/versions'],
    ])('%s %s answers 404', async (method, path) => {
        const p = await startPair();
        const agent = request(p.guard.app);
        const res = method === 'GET' ? await agent.get(path) : await agent.post(path).send({ command: 'echo', username: 'root', password: ROOT_PASS });
        expect(res.status).toBe(404);
        // the normal server still serves its routes
        expect((await request(p.main.app).get('/api/qcli/versions')).status).toBe(200);
    });

    it('no seeding', async () => {
        const stores = {
            userStore: new InMemoryUserStore(),
            groupStore: new InMemoryGroupStore(),
            apiTokenStore: new InMemoryApiTokenStore(),
        };
        const plugin = new CliUsersBuilder().setOptions(stores).setGuardOnly().build();
        await plugin.ready;
        disposables.push(() => plugin.dispose());
        expect(await stores.userStore.getUsers()).toEqual([]);
        expect(await stores.groupStore.getGroups()).toEqual([]);
        expect(plugin.protectServer).toBe(false);
        expect(plugin.serverAuth.protectServer).toBe(false);
    });

    it('mountPlugin of a CLI plugin logs and skips', async () => {
        const cli = createCliServer({ cliRoutes: false });
        track(cli);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const jobs = new CliJobsBuilder().build();
        cli.mountPlugin(jobs);
        expect(warn).toHaveBeenCalledWith('[qcli] CLI routes are turned off; /api/v1/qcli/jobs is not mounted');
        expect((await request(cli.app).get('/api/v1/qcli/jobs')).status).toBe(404);
        // still listed among the installed plugins
        expect(cli.builder.installedPlugins.map((p) => p.id)).toContain('@qodalis/cli-server-plugin-jobs');
    });

    it('the admin dashboard serves nothing without CLI routes', async () => {
        const cli = createCliServer({ cliRoutes: false });
        track(cli);
        const admin = new CliAdminBuilder()
            .setCredentials('dashadmin', 'dashpass')
            .setJwtSecret('test-secret')
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
        admin.logBuffer.restoreConsole();
        disposables.push(() => admin.dispose());
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        cli.mountPlugin(admin);
        expect(warn).toHaveBeenCalledWith('[qcli] the CLI routes are turned off (cliRoutes: false); the admin dashboard is not served');
        expect((await request(cli.app).get('/qcli/admin/')).status).toBe(404);
        expect((await request(cli.app).get('/api/v1/qcli/status')).status).toBe(404);
    });

    it('the catalog still serves host entries', async () => {
        const p = await startPair();
        expect(p.guard.builder.permissions.find('rates:read')).toBeTruthy();
    });

    it('no socket handlers are attached', async () => {
        const cli = createCliServer({ cliRoutes: false });
        track(cli);
        const server = http.createServer(cli.app);
        cli.eventSocketManager.attach(server);
        cli.logSocketManager.attach(server);
        expect(server.listenerCount('upgrade')).toBe(0);
    });

    it('guard-only fails closed on a server with CLI routes, whatever the order', () => {
        const users = () => new CliUsersBuilder().setGuardOnly().build();
        const a = users();
        const withRoutes = createCliServer();
        track(withRoutes, a);
        expect(() => withRoutes.mountPlugin(a)).toThrow('guard-only needs cliRoutes: false');
        const b = users();
        track(withRoutes, b);
        expect(() => withRoutes.setAuth(b.serverAuth)).toThrow('guard-only needs cliRoutes: false');
        const c = users();
        disposables.push(() => c.dispose());
        expect(() => createCliServer({ auth: c.serverAuth })).toThrow('guard-only needs cliRoutes: false');
        // a normal users plugin there is unchanged
        const normal = new CliUsersBuilder().setOptions({ defaultAdminPassword: ROOT_PASS }).build();
        track(withRoutes, normal);
        expect(() => withRoutes.mountPlugin(normal)).not.toThrow();
    });

    it('a guard-only plugin never mounted: its guards answer 500, the CLI is not left open behind them', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const users = new CliUsersBuilder().setGuardOnly().build();
        disposables.push(() => users.dispose());
        const cli = createCliServer();
        track(cli);
        cli.app.get('/host/rates', users.requireHostToken('rates:read'), (_req, res) => res.json({ ok: true }));
        cli.app.get('/host/me', users.requireAuth(), (_req, res) => res.json({ ok: true }));
        const api = new CliPublicApiBuilder().setUsers(users).build();
        cli.app.get('/v1/rates', api.guard('rates:read'), (_req, res) => res.json({ ok: true }));
        for (const p of ['/host/rates', '/host/me', '/v1/rates']) {
            const res = await request(cli.app).get(p).set(auth('qcli_pat_anything'));
            expect(res.status, p).toBe(500);
            expect(res.body).toEqual({ error: 'internal server error' });
        }
        expect(errors).toHaveBeenCalledTimes(1);
        expect(String(errors.mock.calls[0][0])).toContain('guard-only needs cliRoutes: false');
    });

    it('a guard-only plugin mounted on a server with CLI routes: startup error, guards stay closed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const users = new CliUsersBuilder().setGuardOnly().build();
        const cli = createCliServer();
        track(cli, users);
        expect(() => cli.mountPlugin(users)).toThrow('guard-only needs cliRoutes: false');
        // even when the provider is attached directly, bypassing the server's check
        expect(() => users.serverAuth.attachToServer({ broadcast: () => undefined })).toThrow('guard-only needs cliRoutes: false');
        cli.app.get('/host/me', users.requireAuth(), (_req, res) => res.json({ ok: true }));
        expect((await request(cli.app).get('/host/me')).status).toBe(500);
    });

    it.each(['plugin first', 'server first'])('a guard-only plugin mounted on a server without CLI routes works (%s)', async (order) => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let users: UsersPluginResult;
        let cli: CliServerResult;
        if (order === 'plugin first') {
            users = new CliUsersBuilder().setGuardOnly().build();
            cli = createCliServer({ cliRoutes: false });
        } else {
            cli = createCliServer({ cliRoutes: false });
            users = new CliUsersBuilder().setGuardOnly().build();
        }
        track(cli, users);
        // guards registered before mounting answer once the plugin is mounted
        cli.app.get('/host/me', users.requireAuth(), (_req, res) => res.json({ ok: true }));
        cli.mountPlugin(users);
        const res = await request(cli.app).get('/host/me');
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('MCP and the sockets answer 404 without CLI routes', async () => {
        const cli = createCliServer({ cliRoutes: false, mcp: true, enableShell: true, shell: { allowAnonymous: true } });
        const users = new CliUsersBuilder().setGuardOnly().build();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        cli.mountPlugin(users);
        track(cli, users);
        expect((await request(cli.app).post('/api/qcli/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
        const server = http.createServer(cli.app);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        cli.eventSocketManager.attach(server);
        cli.logSocketManager.attach(server);
        const port = (server.address() as { port: number }).port;
        try {
            for (const p of ['/ws/v1/qcli/events', '/ws/v1/qcli/shell', '/ws/qcli/logs']) {
                const status = await new Promise<number | undefined>((resolve) => {
                    const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`);
                    ws.on('unexpected-response', (_req, res) => {
                        resolve(res.statusCode);
                        res.resume();
                        ws.terminate();
                    });
                    ws.on('open', () => {
                        resolve(101);
                        ws.terminate();
                    });
                    ws.on('error', () => resolve(undefined));
                });
                expect(status, p).toBe(404);
            }
        } finally {
            server.closeAllConnections?.();
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('default server unchanged', async () => {
        const cli = createCliServer({ configure: (b) => b.addProcessor(new CliEchoCommandProcessor()) });
        track(cli);
        expect((await request(cli.app).get('/api/v1/qcli/commands')).status).toBe(200);
        expect((await request(cli.app).get('/api/qcli/versions')).status).toBe(200);
        const server = http.createServer(cli.app);
        cli.eventSocketManager.attach(server);
        expect(server.listenerCount('upgrade')).toBe(1);
    });
});

describe('host-route plugins (cliRoutes: false)', () => {
    async function unprotected(): Promise<{ cli: CliServerResult; users: UsersPluginResult; token: string }> {
        const cli = createCliServer();
        cli.builder.addPermissions(RATES);
        const users = new CliUsersBuilder()
            .setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4 })
            .setProtectServer(false)
            .build();
        await users.ready;
        cli.mountPlugin(users);
        track(cli, users);
        await users.groupStore.createGroup({ name: 'customers', permissions: ['rates:read'] });
        const alice = await users.userStore.createUser({ name: 'alice', email: 'alice@example.com', groups: ['customers'] });
        const { token } = await users.apiTokens.create(alice.id, { name: 'site', audience: 'host', permissions: ['rates:read'] });
        return { cli, users, token };
    }

    function stub(prefix: string, cliRoutes?: boolean) {
        const router = Router();
        router.get('/ping', (_req, res) => res.json({ ok: true }));
        return { prefix, router, ...(cliRoutes === undefined ? {} : { cliRoutes }) };
    }

    it('a cliRoutes:false plugin prefix is not a CLI route', async () => {
        const { cli, token } = await unprotected();
        cli.mountPlugin(stub('/qcli/x', false));
        const res = await request(cli.app).get('/qcli/x/ping').set(auth(token));
        expect(res.status).toBe(200);
    });

    it('a plugin prefix is a CLI route by default', async () => {
        const { cli, token } = await unprotected();
        cli.mountPlugin(stub('/qcli/y'));
        const res = await request(cli.app).get('/qcli/y/ping').set(auth(token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden: host tokens cannot use CLI routes' });
    });

    it('a cliRoutes:false plugin is mounted on a server without CLI routes', async () => {
        const cli = createCliServer({ cliRoutes: false });
        track(cli);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        cli.mountPlugin(stub('/qcli/x', false));
        expect(warn).not.toHaveBeenCalled();
        expect((await request(cli.app).get('/qcli/x/ping')).status).toBe(200);
    });
});
