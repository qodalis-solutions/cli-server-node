/**
 * Appendix B — server-wide protection (B1), WebSockets (B2) and the admin
 * dashboard through the users plugin (B10), on a full createCliServer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { ICliCommandProcessor } from '../abstractions';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { InMemoryFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';

const ORIGIN = 'http://localhost:4300';
const ROOT_PASS = 'rootpass1';
const V1 = '/api/v1/qcli';

function proc(command: string, opts: Partial<ICliCommandProcessor> = {}): ICliCommandProcessor {
    return {
        command,
        description: command,
        author: DefaultLibraryAuthor,
        version: '1.0.0',
        handleAsync: async () => `${command} ok`,
        ...opts,
    };
}

interface Harness {
    cli: CliServerResult;
    users: UsersPluginResult;
    admin: CliAdminPluginResult;
    server: http.Server;
    port: number;
    broadcast: ReturnType<typeof vi.fn>;
}

async function startHarness(opts: { enableShell?: boolean; protectServer?: boolean } = {}): Promise<Harness> {
    const cli = createCliServer({
        allowedOrigins: [ORIGIN, 'http://127.0.0.1:*'],
        enableShell: opts.enableShell ?? false,
        configure: (b) => {
            b.addProcessor(proc('echo'));
            b.addProcessor(
                proc('vault', {
                    requiredPermissions: ['vault:read'],
                    processors: [proc('rotate', { requiredPermissions: ['vault:rotate'] })],
                }),
            );
            b.setFileStorageProvider(new InMemoryFileStorageProvider());
        },
    });
    const broadcast = vi.fn((msg: Record<string, unknown>) => cli.eventSocketManager.broadcastMessage(msg));
    const users = new CliUsersBuilder()
        .setDefaultAdminPassword(ROOT_PASS)
        .setIpRateLimit(10_000)
        .setProtectServer(opts.protectServer ?? true)
        .build(broadcast);
    await users.ready;
    const admin = new CliAdminBuilder()
        .setCredentials('dashadmin', 'dashpass')
        .setJwtSecret('test-secret')
        .setAuthProvider(users.serverAuth)
        .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
    admin.logBuffer.restoreConsole();
    cli.mountPlugin(new CliJobsBuilder().build());
    cli.mountPlugin(admin);
    cli.mountPlugin(users);

    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(server);
    cli.logSocketManager.attach(server);
    return { cli, users, admin, server, port: (server.address() as AddressInfo).port, broadcast };
}

async function stopHarness(h: Harness | undefined): Promise<void> {
    if (!h) return;
    h.cli.eventSocketManager.dispose();
    h.cli.logSocketManager.dispose();
    h.users.dispose();
    h.admin.dispose();
    await new Promise<void>((r) => h.server.close(() => r()));
}

async function login(app: express.Express, username: string, password: string) {
    const res = await request(app).post(`${V1}/sessions`).send({ username, password });
    if (res.status !== 201) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
    return { token: res.body.token as string, sessionId: res.body.session.id as string, userId: res.body.session.user.id as string };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function ticket(app: express.Express, token: string): Promise<string> {
    const res = await request(app).post(`${V1}/sessions/ws-ticket`).set(bearer(token));
    expect(res.status).toBe(201);
    return res.body.ticket;
}

/** Opens a WS; resolves with the open socket or the HTTP status of a rejected upgrade. */
function connect(port: number, path: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number; messages: any[] }> {
    return new Promise((resolve) => {
        const messages: any[] = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
        ws.on('open', () => resolve({ ws, messages }));
        ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode, messages }));
        ws.on('error', () => resolve({ status: -1, messages }));
    });
}

/** Opens a WS that the server accepts and then closes; resolves with the close code and reason. */
function closeOf(port: number, path: string, headers: Record<string, string> = {}): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on('unexpected-response', (_req, res) => resolve({ code: -res.statusCode!, reason: '' }));
        ws.on('error', () => undefined);
    });
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
    }
};

// ---------------------------------------------------------------------------
// B1 — the users plugin protects the whole server
// ---------------------------------------------------------------------------

describe('B1: server protection', () => {
    let h: Harness;
    let app: express.Express;
    let root: string;
    let plain: string;
    let files: string;

    beforeAll(async () => {
        h = await startHarness();
        app = h.cli.app;
        root = (await login(app, 'root', ROOT_PASS)).token;
        const mk = (body: object) => request(app).post(`${V1}/users`).set(bearer(root)).send(body).expect(201);
        await request(app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'readers', permissions: ['files:read', 'vault:read'] }).expect(201);
        await mk({ name: 'plain', email: 'plain@x.io', password: 'plainpass' });
        await mk({ name: 'files', email: 'files@x.io', password: 'filespass', groups: ['users', 'readers'] });
        plain = (await login(app, 'plain', 'plainpass')).token;
        files = (await login(app, 'files', 'filespass')).token;
    });
    afterAll(() => stopHarness(h));

    it('denies anonymous access to every server route (401 {error})', async () => {
        const cases: Array<[string, string]> = [
            ['get', `${V1}/commands`],
            ['post', `${V1}/execute`],
            ['post', `${V1}/execute/stream`],
            ['post', '/api/qcli/execute'],
            ['get', '/api/qcli/commands'],
            ['get', '/api/qcli/fs/ls?path=/'],
            ['post', '/api/qcli/fs/mkdir'],
            ['get', `${V1}/jobs`],
            ['get', '/api/qcli/data-explorer/sources'],
            ['get', `${V1}/status`],
            ['get', '/API/V1/QCLI/commands'],
            ['get', '/api//v1/qcli/commands'],
        ];
        for (const [method, path] of cases) {
            const res = await (request(app) as any)[method](path).send({ command: 'echo' });
            expect(res.status, `${method} ${path}`).toBe(401);
            expect(res.body.error, `${method} ${path}`).toBeDefined();
        }
    });

    it('keeps login, version discovery and capabilities public', async () => {
        for (const path of ['/api/qcli/versions', `${V1}/version`, `${V1}/capabilities`]) {
            expect((await request(app).get(path)).status, path).toBe(200);
        }
        expect((await request(app).post(`${V1}/sessions`).send({ username: 'root', password: ROOT_PASS })).status).toBe(201);
    });

    it('enforces commands:execute and processor requiredPermissions', async () => {
        expect((await request(app).get(`${V1}/commands`).set(bearer(plain))).status).toBe(200);
        const echo = await request(app).post(`${V1}/execute`).set(bearer(plain)).send({ command: 'echo' });
        expect(echo.status).toBe(200);
        const vault = await request(app).post(`${V1}/execute`).set(bearer(plain)).send({ command: 'vault' });
        expect(vault.status).toBe(403);
        expect(vault.body.error).toContain('vault:read');
        const stream = await request(app).post(`${V1}/execute/stream`).set(bearer(plain)).send({ command: 'VAULT' });
        expect(stream.status).toBe(403);

        expect((await request(app).post(`${V1}/execute`).set(bearer(files)).send({ command: 'vault' })).status).toBe(200);
        const rotate = await request(app).post(`${V1}/execute`).set(bearer(files)).send({ command: 'vault', chainCommands: ['rotate'] });
        expect(rotate.status).toBe(403);
        expect(rotate.body.error).toContain('vault:rotate');
        expect((await request(app).post(`${V1}/execute`).set(bearer(root)).send({ command: 'vault', chainCommands: ['rotate'] })).status).toBe(200);
    });

    it('users without commands:execute cannot execute', async () => {
        await request(app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'viewers', permissions: ['users:read'] }).expect(201);
        await request(app).post(`${V1}/users`).set(bearer(root)).send({ name: 'viewer', email: 'v@x.io', password: 'viewpass', groups: ['viewers'] }).expect(201);
        const viewer = (await login(app, 'viewer', 'viewpass')).token;
        expect((await request(app).get(`${V1}/commands`).set(bearer(viewer))).status).toBe(200);
        expect((await request(app).post(`${V1}/execute`).set(bearer(viewer)).send({ command: 'echo' })).status).toBe(403);
    });

    it('fs read needs files:read, fs write needs files:write', async () => {
        expect((await request(app).get('/api/qcli/fs/ls?path=/').set(bearer(plain))).status).toBe(403);
        const ls = await request(app).get('/api/qcli/fs/ls?path=/').set(bearer(files));
        expect([200, 404]).toContain(ls.status);
        expect((await request(app).post('/api/qcli/fs/mkdir').set(bearer(files)).send({ path: '/x' })).status).toBe(403);
        expect((await request(app).delete('/api/qcli/fs/rm?path=/x').set(bearer(files))).status).toBe(403);
        const mk = await request(app).post('/api/qcli/fs/mkdir').set(bearer(root)).send({ path: '/x' });
        expect(mk.status).not.toBe(401);
        expect(mk.status).not.toBe(403);
    });

    it('data explorer needs data:query; jobs read/manage need jobs:read / jobs:manage', async () => {
        expect((await request(app).get('/api/qcli/data-explorer/sources').set(bearer(plain))).status).toBe(403);
        expect((await request(app).get(`${V1}/jobs`).set(bearer(plain))).status).toBe(403);
        expect((await request(app).post(`${V1}/jobs/x/trigger`).set(bearer(plain))).status).toBe(403);
        expect((await request(app).get(`${V1}/jobs`).set(bearer(root))).status).toBe(200);
    });

    it('exports requireAuth / requirePermission guards for host routes', async () => {
        const host = express();
        host.get('/mine', h.users.requireAuth(), (req, res) => res.json({ user: req.qcliAuth!.user.name }));
        host.get('/deploy', h.users.requirePermission('deploy:run'), (_req, res) => res.json({ ok: true }));
        expect((await request(host).get('/mine')).status).toBe(401);
        expect((await request(host).get('/mine').set(bearer(plain))).body).toEqual({ user: 'plain' });
        expect((await request(host).get('/deploy').set(bearer(plain))).status).toBe(403);
        expect((await request(host).get('/deploy').set(bearer(root))).status).toBe(200);
    });

    it('CORS only for allowed origins', async () => {
        const ok = await request(app).get('/api/qcli/versions').set('Origin', ORIGIN);
        expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
        const port = await request(app).get('/api/qcli/versions').set('Origin', 'http://127.0.0.1:5555');
        expect(port.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5555');
        const bad = await request(app).get('/api/qcli/versions').set('Origin', 'https://evil.example');
        expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    });
});

describe('B1: without the users plugin (or protectServer: false) the server stays open', () => {
    it('anonymous execute works without the users plugin; CORS is off by default', async () => {
        const { app } = createCliServer({ configure: (b) => b.addProcessor(proc('echo')) });
        expect((await request(app).post(`${V1}/execute`).send({ command: 'echo' })).status).toBe(200);
        const res = await request(app).get('/api/qcli/versions').set('Origin', ORIGIN);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        const permissive = createCliServer({ cors: true });
        expect((await request(permissive.app).get('/api/qcli/versions').set('Origin', ORIGIN)).headers['access-control-allow-origin']).toBe('*');
    });

    it('protectServer: false leaves server routes open', async () => {
        const h = await startHarness({ protectServer: false });
        try {
            expect((await request(h.cli.app).post(`${V1}/execute`).send({ command: 'echo' })).status).toBe(200);
            // users routes still require auth
            expect((await request(h.cli.app).get(`${V1}/users`)).status).toBe(401);
        } finally {
            await stopHarness(h);
        }
    });
});

describe('B1: server auth gate errors', () => {
    function gated(error: unknown) {
        return createCliServer({
            configure: (b) => b.addProcessor(proc('echo')),
            auth: {
                protectServer: true,
                handlesPath: () => false,
                authenticateRequest: async () => {
                    throw error;
                },
                consumeTicket: async () => undefined,
                hasPermission: () => true,
            },
        }).app;
    }

    it('unexpected provider errors give a generic 500 and are logged, never leaked', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await request(gated(new Error('SQLITE_CANTOPEN: /var/secret/users.db'))).post(`${V1}/execute`).send({ command: 'echo' });
            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'internal server error' });
            expect(JSON.stringify(res.body)).not.toContain('SQLITE');
            expect(spy.mock.calls.some((args) => args.some((a) => String(a instanceof Error ? a.message : a).includes('SQLITE_CANTOPEN')))).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    it('auth errors carrying a status keep their status and message', async () => {
        const unauth = Object.assign(new Error('session expired'), { status: 401 });
        const res = await request(gated(unauth)).post(`${V1}/execute`).send({ command: 'echo' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'session expired' });
        const pwd = Object.assign(new Error('password change required'), { status: 403 });
        const res2 = await request(gated(pwd)).post(`${V1}/execute`).send({ command: 'echo' });
        expect(res2.status).toBe(403);
        expect(res2.body).toEqual({ error: 'password change required' });
    });

    describe("the users plugin's requireAuth / requirePermission guards", () => {
        const guarded = (error: unknown) => {
            const users = new CliUsersBuilder()
                .setAuthAdapter(() => {
                    throw error;
                })
                .build();
            const host = express();
            host.get('/mine', users.serverAuth.requireAuth(), (_req, res) => res.json({ ok: true }));
            host.get('/deploy', users.serverAuth.requirePermission('deploy:run'), (_req, res) => res.json({ ok: true }));
            return { host, users };
        };

        it('answer unexpected errors with a generic 500 and log them', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const { host, users } = guarded(new Error('SQLITE_CANTOPEN: /var/secret/users.db'));
            try {
                for (const path of ['/mine', '/deploy']) {
                    const res = await request(host).get(path);
                    expect(res.status).toBe(500);
                    expect(res.body).toEqual({ error: 'internal server error' });
                }
                expect(spy.mock.calls.some((args) => args.some((a) => String(a instanceof Error ? a.message : a).includes('SQLITE_CANTOPEN')))).toBe(true);
            } finally {
                spy.mockRestore();
                users.dispose();
            }
        });

        it('keep the status and message of errors carrying a numeric status', async () => {
            const { host, users } = guarded(Object.assign(new Error('host session expired'), { status: 401 }));
            const res = await request(host).get('/mine');
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ error: 'host session expired' });
            users.dispose();
        });
    });
});

// ---------------------------------------------------------------------------
// B2 — WebSockets
// ---------------------------------------------------------------------------

describe('B2: WebSocket tickets, origins, scoping', () => {
    let h: Harness;
    let app: express.Express;
    let root: Awaited<ReturnType<typeof login>>;
    let plain: Awaited<ReturnType<typeof login>>;

    beforeAll(async () => {
        h = await startHarness({ enableShell: true });
        app = h.cli.app;
        root = await login(app, 'root', ROOT_PASS);
        await request(app).post(`${V1}/users`).set(bearer(root.token)).send({ name: 'plain', email: 'plain@x.io', password: 'plainpass' }).expect(201);
        plain = await login(app, 'plain', 'plainpass');
    });
    afterAll(() => stopHarness(h));

    it('POST /sessions/ws-ticket returns a 32-byte hex ticket valid for 30 s', async () => {
        const res = await request(app).post(`${V1}/sessions/ws-ticket`).set(bearer(plain.token));
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ ticket: expect.stringMatching(/^[0-9a-f]{64}$/), expiresIn: 30 });
        expect((await request(app).post(`${V1}/sessions/ws-ticket`)).status).toBe(401);
    });

    it('events socket requires a ticket; tickets are single-use', async () => {
        expect((await connect(h.port, '/ws/v1/qcli/events')).status).toBe(401);
        expect((await connect(h.port, '/ws/v1/qcli/events?ticket=deadbeef')).status).toBe(401);
        // bearer tokens are not accepted in the query string
        expect((await connect(h.port, `/ws/v1/qcli/events?token=${plain.token}`)).status).toBe(401);
        expect((await connect(h.port, `/ws/v1/qcli/events?ticket=${plain.token}`)).status).toBe(401);

        const t = await ticket(app, plain.token);
        const first = await connect(h.port, `/ws/v1/qcli/events?ticket=${t}`);
        expect(first.ws).toBeDefined();
        first.ws!.close();
        expect((await connect(h.port, `/ws/v1/qcli/events?ticket=${t}`)).status).toBe(401);
    });

    it('expired tickets are rejected', async () => {
        const t = await ticket(app, plain.token);
        const now = Date.now();
        const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
        try {
            expect(await h.users.serverAuth.consumeTicket(t)).toBeUndefined();
        } finally {
            spy.mockRestore();
        }
    });

    it('tickets die with their session', async () => {
        const s = await login(app, 'plain', 'plainpass');
        const t = await ticket(app, s.token);
        await request(app).delete(`${V1}/sessions/current`).set(bearer(s.token)).expect(204);
        expect((await connect(h.port, `/ws/v1/qcli/events?ticket=${t}`)).status).toBe(401);
    });

    it('checks the Origin of every upgrade', async () => {
        const t = await ticket(app, plain.token);
        expect((await connect(h.port, `/ws/v1/qcli/events?ticket=${t}`, { Origin: 'https://evil.example' })).status).toBe(403);
        const t2 = await ticket(app, plain.token);
        const ok = await connect(h.port, `/ws/v1/qcli/events?ticket=${t2}`, { Origin: ORIGIN });
        expect(ok.ws).toBeDefined();
        ok.ws!.close();
        expect((await connect(h.port, '/ws/v1/qcli/logs', { Origin: 'https://evil.example' })).status).toBe(403);
    });

    it('logs socket requires logs:read; shell requires shell:execute', async () => {
        expect((await connect(h.port, '/ws/v1/qcli/logs')).status).toBe(401);
        expect((await connect(h.port, `/ws/v1/qcli/logs?ticket=${await ticket(app, plain.token)}`)).status).toBe(403);
        const logs = await connect(h.port, `/ws/v1/qcli/logs?ticket=${await ticket(app, root.token)}`);
        expect(logs.ws).toBeDefined();
        logs.ws!.close();

        // Shell refusals are accept-then-close (C5) so browsers can read them
        expect(await closeOf(h.port, '/ws/v1/qcli/shell')).toEqual({ code: 4401, reason: 'login required' });
        expect(await closeOf(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(app, plain.token)}&cmd=id`)).toEqual({
            code: 4403,
            reason: 'forbidden',
        });
        const shell = await connect(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(app, root.token)}&cmd=sleep%205`);
        expect(shell.ws).toBeDefined();
        await waitFor(() => shell.messages.some((m) => m.type === 'ready'));
        shell.ws!.terminate();
    });

    it('session-kicked goes only to the affected user, and closes that session socket', async () => {
        const victim = await login(app, 'plain', 'plainpass');
        const victimWs = await connect(h.port, `/ws/v1/qcli/events?ticket=${await ticket(app, victim.token)}`);
        const otherPlainWs = await connect(h.port, `/ws/v1/qcli/events?ticket=${await ticket(app, plain.token)}`);
        const rootWs = await connect(h.port, `/ws/v1/qcli/events?ticket=${await ticket(app, root.token)}`);
        let closeCode = 0;
        victimWs.ws!.on('close', (code) => (closeCode = code));

        await request(app).delete(`${V1}/sessions/${victim.sessionId}`).set(bearer(root.token)).expect(204);
        await waitFor(() => closeCode !== 0);
        expect(closeCode).toBe(4401);

        const kicked = (m: any[]) => m.filter((x) => x.type === 'session-kicked');
        expect(kicked(victimWs.messages)).toEqual([
            { type: 'session-kicked', data: { sessionId: victim.sessionId, userId: victim.userId, reason: 'revoked' } },
        ]);
        await new Promise((r) => setTimeout(r, 50));
        expect(kicked(otherPlainWs.messages)).toHaveLength(1); // same user, other session: informed, not closed
        expect(otherPlainWs.ws!.readyState).toBe(WebSocket.OPEN);
        expect(kicked(rootWs.messages)).toHaveLength(0);
        otherPlainWs.ws!.close();
        rootWs.ws!.close();
    });

    it('log events reach only sockets with logs:read', async () => {
        const plainWs = await connect(h.port, `/ws/v1/qcli/events?ticket=${await ticket(app, plain.token)}`);
        const rootWs = await connect(h.port, `/ws/v1/qcli/events?ticket=${await ticket(app, root.token)}`);
        h.cli.eventSocketManager.broadcastMessage({ type: 'log:entry', message: 'secret log' });
        h.cli.eventSocketManager.broadcastMessage({ type: 'hello' });
        await waitFor(() => rootWs.messages.some((m) => m.type === 'hello') && plainWs.messages.some((m) => m.type === 'hello'));
        expect(rootWs.messages.some((m) => m.type === 'log:entry')).toBe(true);
        expect(plainWs.messages.some((m) => m.type === 'log:entry')).toBe(false);
        plainWs.ws!.close();
        rootWs.ws!.close();
    });

    it('shell is disabled by default', async () => {
        const off = await startHarness();
        try {
            const r = await login(off.cli.app, 'root', ROOT_PASS);
            expect(await closeOf(off.port, `/ws/v1/qcli/shell?ticket=${await ticket(off.cli.app, r.token)}`)).toEqual({
                code: 4404,
                reason: 'shell disabled',
            });
        } finally {
            await stopHarness(off);
        }
    });

    it('password-change-required sessions cannot get tickets', async () => {
        await request(app).put(`${V1}/users/plain/password`).set(bearer(root.token)).send({ password: 'resetpass1' }).expect(204);
        const s = await login(app, 'plain', 'resetpass1');
        const res = await request(app).post(`${V1}/sessions/ws-ticket`).set(bearer(s.token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'password change required' });
        expect((await request(app).post(`${V1}/execute`).set(bearer(s.token)).send({ command: 'echo' })).status).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// B10 — admin dashboard through the users plugin
// ---------------------------------------------------------------------------

describe('B10: admin dashboard authenticates through the users plugin', () => {
    let h: Harness;
    let app: express.Express;

    beforeAll(async () => {
        h = await startHarness();
        app = h.cli.app;
        const root = (await login(app, 'root', ROOT_PASS)).token;
        await request(app).post(`${V1}/users`).set(bearer(root)).send({ name: 'plain', email: 'plain@x.io', password: 'plainpass' }).expect(201);
        await request(app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'ops', permissions: ['admin:access', 'commands:execute'] }).expect(201);
        await request(app).post(`${V1}/users`).set(bearer(root)).send({ name: 'op', email: 'op@x.io', password: 'oppass12', groups: ['ops'] }).expect(201);
    });
    afterAll(() => stopHarness(h));

    it('dashboard login uses users credentials and requires admin:access', async () => {
        const ok = await request(app).post(`${V1}/auth/login`).send({ username: 'root', password: ROOT_PASS });
        expect(ok.status).toBe(200);
        expect(ok.body.username).toBe('root');
        expect(ok.body.expiresIn).toBeGreaterThan(0);
        expect((await request(app).get(`${V1}/status`).set(bearer(ok.body.token))).status).toBe(200);
        expect((await request(app).get(`${V1}/auth/me`).set(bearer(ok.body.token))).body.username).toBe('root');

        const op = await request(app).post(`${V1}/auth/login`).send({ username: 'op', password: 'oppass12' });
        expect(op.status).toBe(200);
        expect((await request(app).get(`${V1}/plugins`).set(bearer(op.body.token))).status).toBe(200);

        const denied = await request(app).post(`${V1}/auth/login`).send({ username: 'plain', password: 'plainpass' });
        expect(denied.status).toBe(403);
        expect(denied.body.error).toContain('admin:access');
    });

    it('static dashboard credentials are not used when the users plugin is installed', async () => {
        expect((await request(app).post(`${V1}/auth/login`).send({ username: 'dashadmin', password: 'dashpass' })).status).toBe(401);
    });

    it('a users token without admin:access cannot use admin routes', async () => {
        const plain = (await login(app, 'plain', 'plainpass')).token;
        expect((await request(app).get(`${V1}/status`).set(bearer(plain))).status).toBe(403);
        expect((await request(app).get(`${V1}/config`).set(bearer(plain))).status).toBe(403);
        expect((await request(app).get(`${V1}/status`)).status).toBe(401);
    });
});
