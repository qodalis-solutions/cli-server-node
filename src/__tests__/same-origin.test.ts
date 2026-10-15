/**
 * Same-origin requests (e.g. the admin dashboard SPA served by the server at
 * /qcli/admin) always pass the Origin / CSRF checks, even when
 * `allowedOrigins` does not list the server's own origin.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import express, { Request } from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { isSameOrigin, requestOrigin } from '../auth/cli-server-auth';
import { CliUsersBuilder, UsersPluginResult, User, AuthAdapter } from '../../plugins/users/index';
import { isSameOrigin as usersIsSameOrigin } from '../../plugins/users/security';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';

const FRONTEND = 'http://localhost:4300';
const SERVER_HOST = 'localhost:8047';
const SERVER_ORIGIN = `http://${SERVER_HOST}`;
const ROOT_PASS = 'rootpass1';
const V1 = '/api/v1/qcli';

function fakeReq(headers: Record<string, string>, opts: { encrypted?: boolean; trustProxyFn?: (addr?: string) => boolean } = {}) {
    return {
        headers,
        socket: { encrypted: opts.encrypted, remoteAddress: '10.0.0.1' },
        app: opts.trustProxyFn ? { get: (name: string) => (name === 'trust proxy fn' ? opts.trustProxyFn : undefined) } : undefined,
    };
}

describe.each([
    ['server', isSameOrigin],
    ['users plugin', usersIsSameOrigin],
])('isSameOrigin (%s)', (_name, fn) => {
    it('matches the request origin, case-insensitively, with default ports normalized', () => {
        expect(fn('http://localhost:8047', fakeReq({ host: 'localhost:8047' }))).toBe(true);
        expect(fn('HTTP://LocalHost:8047/', fakeReq({ host: 'localhost:8047' }))).toBe(true);
        expect(fn('http://example.com', fakeReq({ host: 'example.com:80' }))).toBe(true);
        expect(fn('http://example.com:80', fakeReq({ host: 'Example.COM' }))).toBe(true);
        expect(fn('https://example.com', fakeReq({ host: 'example.com:443' }, { encrypted: true }))).toBe(true);
        expect(fn('http://[::1]:8047', fakeReq({ host: '[::1]:8047' }))).toBe(true);
    });

    it('rejects other origins, schemes and ports', () => {
        expect(fn('http://localhost:4300', fakeReq({ host: 'localhost:8047' }))).toBe(false);
        expect(fn('https://localhost:8047', fakeReq({ host: 'localhost:8047' }))).toBe(false);
        expect(fn('http://example.com', fakeReq({ host: 'example.com' }, { encrypted: true }))).toBe(false);
        expect(fn('http://evil.example', fakeReq({ host: 'localhost:8047' }))).toBe(false);
        expect(fn('null', fakeReq({ host: 'localhost:8047' }))).toBe(false);
        expect(fn(undefined, fakeReq({ host: 'localhost:8047' }))).toBe(false);
        expect(fn('http://localhost:8047', fakeReq({}))).toBe(false);
        expect(fn('not a url', fakeReq({ host: 'localhost:8047' }))).toBe(false);
    });

    it('honours X-Forwarded-Proto / X-Forwarded-Host only behind a trusted proxy', () => {
        const proxied = { host: 'internal:8047', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cli.example.com' };
        expect(fn('https://cli.example.com', fakeReq(proxied))).toBe(false);
        expect(fn('https://cli.example.com', fakeReq(proxied), true)).toBe(true);
        expect(fn('https://cli.example.com', fakeReq(proxied, { trustProxyFn: () => true }))).toBe(true);
        expect(fn('https://cli.example.com', fakeReq(proxied, { trustProxyFn: () => false }))).toBe(false);
        // wss forwarded proto maps to https
        expect(fn('https://cli.example.com', fakeReq({ host: 'cli.example.com', 'x-forwarded-proto': 'wss' }), true)).toBe(true);
    });

    it('takes X-Forwarded-Proto / X-Forwarded-Host from the trusted hop, like X-Forwarded-For', () => {
        // one hop: the rightmost entry (appended by the proxy); leftmost entries are client-controlled
        const spoofed = { host: 'internal:8047', 'x-forwarded-proto': 'http, https', 'x-forwarded-host': 'evil.example, cli.example.com' };
        expect(fn('https://cli.example.com', fakeReq(spoofed), true)).toBe(true);
        expect(fn('http://evil.example', fakeReq(spoofed), true)).toBe(false);
        // n hops: entry at count - n
        const chain = { host: 'internal:8047', 'x-forwarded-proto': 'http, https, http', 'x-forwarded-host': 'a.example, cli.example.com, lb.internal' };
        expect(fn('https://cli.example.com', fakeReq(chain), 2)).toBe(true);
        // fewer entries than hops: the leftmost
        expect(fn('https://cli.example.com', fakeReq({ host: 'internal:8047', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cli.example.com' }), 3)).toBe(true);
        // an empty selected entry is ignored (socket scheme / Host header)
        expect(fn('http://internal:8047', fakeReq({ host: 'internal:8047', 'x-forwarded-proto': 'https, ', 'x-forwarded-host': 'cli.example.com, ' }), true)).toBe(true);
        // Express `trust proxy` hop count when trustProxy is omitted
        const app2 = { get: (name: string) => (name === 'trust proxy fn' ? () => true : name === 'trust proxy' ? 2 : undefined) };
        expect(fn('https://cli.example.com', { ...fakeReq(chain), app: app2 })).toBe(true);
    });
});

it('requestOrigin builds scheme://host:port', () => {
    expect(requestOrigin(fakeReq({ host: 'LOCALHOST' }))).toBe('http://localhost:80');
    expect(requestOrigin(fakeReq({ host: 'localhost:8047' }, { encrypted: true }))).toBe('https://localhost:8047');
});

// ---------------------------------------------------------------------------
// HTTP: dashboard login, CORS, users-plugin CSRF
// ---------------------------------------------------------------------------

describe('HTTP same-origin requests', () => {
    let cli: CliServerResult;
    let users: UsersPluginResult;
    let admin: CliAdminPluginResult;

    const boss: User = { id: 'a1', name: 'boss', email: 'boss@host.io', groups: [], createdAt: 0, updatedAt: 0 };
    const adapter: AuthAdapter = (req: Request) => (req.headers.cookie?.includes('sid=ok') ? { user: boss, isAdmin: true } : null);

    beforeAll(async () => {
        cli = createCliServer({ allowedOrigins: [FRONTEND] });
        users = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).build();
        await users.ready;
        admin = new CliAdminBuilder()
            .setJwtSecret('same-origin-secret')
            .setAuthProvider(users.serverAuth)
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
        admin.logBuffer.restoreConsole();
        cli.mountPlugin(admin);
        cli.mountPlugin(users);
    });
    afterAll(() => {
        users.dispose();
        admin.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });

    it('dashboard login with Origin = server origin passes (not in allowedOrigins)', async () => {
        const res = await request(cli.app)
            .post(`${V1}/auth/login`)
            .set('Host', SERVER_HOST)
            .set('Origin', SERVER_ORIGIN)
            .send({ username: 'root', password: ROOT_PASS });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        // the dashboard then calls admin routes from the same origin
        const status = await request(cli.app)
            .get(`${V1}/status`)
            .set('Host', SERVER_HOST)
            .set('Origin', SERVER_ORIGIN)
            .set('Authorization', `Bearer ${res.body.token}`);
        expect(status.status).toBe(200);
    });

    it('CORS answers same-origin and configured origins, not foreign ones', async () => {
        const same = await request(cli.app).get('/api/qcli/versions').set('Host', SERVER_HOST).set('Origin', SERVER_ORIGIN);
        expect(same.headers['access-control-allow-origin']).toBe(SERVER_ORIGIN);
        const configured = await request(cli.app).get('/api/qcli/versions').set('Host', SERVER_HOST).set('Origin', FRONTEND);
        expect(configured.headers['access-control-allow-origin']).toBe(FRONTEND);
        const foreign = await request(cli.app).get('/api/qcli/versions').set('Host', SERVER_HOST).set('Origin', 'https://evil.example');
        expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
        const otherPort = await request(cli.app).get('/api/qcli/versions').set('Host', SERVER_HOST).set('Origin', 'http://localhost:9999');
        expect(otherPort.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('users routes in cookie/adapter mode accept same-origin state changes (CSRF)', async () => {
        const plugin = new CliUsersBuilder().setAuthAdapter(adapter).setAllowedOrigins([FRONTEND]).build();
        await plugin.ready;
        try {
            const app = express();
            app.use(plugin.prefix, plugin.router);
            const post = (origin: string, name: string, host = SERVER_HOST) =>
                request(app).post(`${V1}/groups`).set('Host', host).set('Cookie', 'sid=ok').set('Origin', origin).send({ name });

            expect((await post(SERVER_ORIGIN, 'same-origin')).status).toBe(201);
            expect((await post('HTTP://LOCALHOST:8047', 'same-origin-case')).status).toBe(201);
            expect((await post('http://cli.example.com', 'default-port', 'cli.example.com:80')).status).toBe(201);
            expect((await post(FRONTEND, 'configured')).status).toBe(201);

            const foreign = await post('https://evil.example', 'evil');
            expect(foreign.status).toBe(403);
            expect(foreign.body.error).toBe('cross-site request rejected: origin not allowed');
            expect((await post('http://localhost:9999', 'other-port')).status).toBe(403);
            expect((await post('https://localhost:8047', 'other-scheme')).status).toBe(403);
            // spoofed forwarded headers are ignored without trust proxy
            const spoofed = await request(app)
                .post(`${V1}/groups`)
                .set('Host', SERVER_HOST)
                .set('X-Forwarded-Host', 'evil.example')
                .set('Cookie', 'sid=ok')
                .set('Origin', 'http://evil.example')
                .send({ name: 'spoofed' });
            expect(spoofed.status).toBe(403);
        } finally {
            plugin.dispose();
        }
    });

    it('behind a trusted proxy the forwarded scheme/host define the server origin', async () => {
        const plugin = new CliUsersBuilder().setAuthAdapter(adapter).setAllowedOrigins([FRONTEND]).build();
        await plugin.ready;
        try {
            const app = express();
            app.set('trust proxy', true);
            app.use(plugin.prefix, plugin.router);
            const res = await request(app)
                .post(`${V1}/groups`)
                .set('Host', 'internal:8047')
                .set('X-Forwarded-Proto', 'https')
                .set('X-Forwarded-Host', 'cli.example.com')
                .set('Cookie', 'sid=ok')
                .set('Origin', 'https://cli.example.com')
                .send({ name: 'proxied' });
            expect(res.status).toBe(201);
        } finally {
            plugin.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// WebSocket upgrades
// ---------------------------------------------------------------------------

function connect(port: number, path: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        ws.on('open', () => resolve({ ws }));
        ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
        ws.on('error', () => resolve({ status: -1 }));
    });
}

describe('WebSocket upgrades from the same origin', () => {
    let cli: CliServerResult;
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
        cli = createCliServer({ allowedOrigins: [FRONTEND], enableShell: true, shell: { allowAnonymous: true } });
        server = http.createServer(cli.app);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        cli.eventSocketManager.attach(server);
        cli.logSocketManager.attach(server);
        port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    });

    it('passes the Origin check when Origin equals the Host', async () => {
        for (const path of ['/ws/v1/qcli/events', '/ws/v1/qcli/logs', '/ws/v1/qcli/shell']) {
            const same = await connect(port, path, { Origin: `http://127.0.0.1:${port}` });
            expect(same.ws, path).toBeDefined();
            same.ws!.terminate();
        }
    });

    it('still rejects foreign origins with 403', async () => {
        for (const path of ['/ws/v1/qcli/events', '/ws/v1/qcli/logs', '/ws/v1/qcli/shell']) {
            expect((await connect(port, path, { Origin: 'https://evil.example' })).status, path).toBe(403);
            expect((await connect(port, path, { Origin: `http://127.0.0.1:${port + 1}` })).status, path).toBe(403);
            expect((await connect(port, path, { Origin: `https://127.0.0.1:${port}` })).status, path).toBe(403);
        }
    });

    it('ignores X-Forwarded-* without trustProxy', async () => {
        const res = await connect(port, '/ws/v1/qcli/events', {
            Origin: 'https://evil.example',
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'evil.example',
        });
        expect(res.status).toBe(403);
    });

    it('honours X-Forwarded-Proto/Host with trustProxy', async () => {
        const proxied = createCliServer({ allowedOrigins: [FRONTEND], trustProxy: true });
        const s = http.createServer(proxied.app);
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
        proxied.eventSocketManager.attach(s);
        const p = (s.address() as AddressInfo).port;
        try {
            const ok = await connect(p, '/ws/v1/qcli/events', {
                Origin: 'https://cli.example.com',
                'X-Forwarded-Proto': 'wss',
                'X-Forwarded-Host': 'cli.example.com',
            });
            expect(ok.ws).toBeDefined();
            ok.ws!.terminate();
            expect((await connect(p, '/ws/v1/qcli/events', { Origin: `http://127.0.0.1:${p}`, 'X-Forwarded-Proto': 'https' })).status).toBe(403);
        } finally {
            proxied.eventSocketManager.dispose();
            proxied.logSocketManager.dispose();
            await new Promise<void>((r) => s.close(() => r()));
        }
    });
});
