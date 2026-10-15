/**
 * Appendix C — remote shell security: access modes (users / token / custom /
 * anonymous / locked), session binding, limits, timeouts, minimal environment,
 * audit and accept-then-close codes. Real HTTP server, real WebSockets, real PTY.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import { format } from 'util';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliShellOptions, tokensEqual, buildShellEnv } from '../services/cli-shell-options';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';

const V1 = '/api/v1/qcli';
const ROOT_PASS = 'rootpass1';
const TOKEN = 'shell-secret-123';

interface Harness {
    cli: CliServerResult;
    users?: UsersPluginResult;
    server: http.Server;
    port: number;
}

const harnesses: Harness[] = [];

async function start(
    opts: { enableShell?: boolean; shell?: CliShellOptions; users?: boolean; configureUsers?: (b: CliUsersBuilder) => void } = {},
): Promise<Harness> {
    const cli = createCliServer({ enableShell: opts.enableShell ?? true, shell: opts.shell });
    let users: UsersPluginResult | undefined;
    if (opts.users) {
        const builder = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000);
        opts.configureUsers?.(builder);
        users = builder.build((msg) => cli.eventSocketManager.broadcastMessage(msg));
        await users.ready;
        cli.mountPlugin(users);
    }
    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(server);
    const h = { cli, users, server, port: (server.address() as AddressInfo).port };
    harnesses.push(h);
    return h;
}

async function stop(h: Harness): Promise<void> {
    h.cli.eventSocketManager.dispose();
    h.users?.dispose();
    h.server.closeAllConnections?.();
    await new Promise<void>((r) => h.server.close(() => r()));
}

afterEach(async () => {
    while (harnesses.length) await stop(harnesses.pop()!);
});

interface Conn {
    ws: WebSocket;
    messages: any[];
    output: () => string;
    closed: Promise<{ code: number; reason: string }>;
    ready: Promise<void>;
}

/** Opens a shell socket and collects its messages and close code. */
function open(port: number, path: string, headers: Record<string, string> = {}): Conn {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const messages: any[] = [];
    let readyResolve!: () => void;
    const ready = new Promise<void>((r) => (readyResolve = r));
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        messages.push(msg);
        if (msg.type === 'ready') readyResolve();
    });
    ws.on('error', () => undefined);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on('unexpected-response', (_req, res) => resolve({ code: -(res.statusCode ?? 0), reason: '' }));
    });
    return {
        ws,
        messages,
        output: () => messages.filter((m) => m.type === 'stdout').map((m) => m.data).join(''),
        closed,
        ready,
    };
}

const closeOf = (port: number, path: string, headers: Record<string, string> = {}) => open(port, path, headers).closed;

const waitFor = async (cond: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
    }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a one-shot command and returns its output once the socket closes normally. */
async function run(port: number, cmd: string, headers: Record<string, string> = {}, extra = ''): Promise<string> {
    const c = open(port, `/ws/v1/qcli/shell?cmd=${encodeURIComponent(cmd)}${extra}`, headers);
    const closed = await c.closed;
    expect(closed.code).toBe(1000);
    return c.output();
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

async function capabilities(h: Harness) {
    const res = await request(h.cli.app).get(`${V1}/capabilities`).expect(200);
    const legacy = await request(h.cli.app).get('/api/qcli/capabilities').expect(200);
    expect({ shell: legacy.body.shell, shellAuth: legacy.body.shellAuth }).toEqual({ shell: res.body.shell, shellAuth: res.body.shellAuth });
    return res.body;
}

/** True when the process no longer runs (gone, or a zombie nobody reaped). */
function processDead(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch {
        return true;
    }
    try {
        return /\)\s+Z\s/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
        return true;
    }
}

// ---------------------------------------------------------------------------
// C1 — enabling and access modes
// ---------------------------------------------------------------------------

describe('C1: enabling and access modes', () => {
    it('is off unless enabled: capabilities shell=false (no shellAuth), socket closed 4404', async () => {
        const h = await start({ enableShell: false, shell: { allowAnonymous: true } });
        const caps = await capabilities(h);
        expect(caps.shell).toBe(false);
        expect(caps).not.toHaveProperty('shellAuth');
        expect(await closeOf(h.port, '/ws/v1/qcli/shell?cmd=id')).toEqual({ code: 4404, reason: 'shell disabled' });
        expect(await closeOf(h.port, '/ws/qcli/shell')).toEqual({ code: 4404, reason: 'shell disabled' });
    });

    it('enabled without any mode is locked: startup ERROR, capabilities "locked", every connection 4401', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const h = await start({ enableShell: true });
            expect(errors.mock.calls.some((c) => /LOCKED/.test(String(c[0])) && /shell\.token/.test(String(c[0])))).toBe(true);
            expect(await capabilities(h)).toMatchObject({ shell: true, shellAuth: 'locked' });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell')).toEqual({ code: 4401, reason: 'shell access not configured' });
            expect(await closeOf(h.port, `/ws/v1/qcli/shell?_header_Authorization=${encodeURIComponent('Bearer x')}`)).toMatchObject({ code: 4401 });
        } finally {
            errors.mockRestore();
        }
    });

    it('anonymous only with allowAnonymous (startup WARNING) and runs commands', async () => {
        const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const h = await start({ shell: { allowAnonymous: true } });
            expect(warns.mock.calls.some((c) => /shell is enabled without authentication/.test(String(c[0])))).toBe(true);
            expect(await capabilities(h)).toMatchObject({ shell: true, shellAuth: 'anonymous' });
            expect(await run(h.port, 'echo hello-anon')).toContain('hello-anon');
        } finally {
            warns.mockRestore();
        }
    });

    describe('token mode', () => {
        it('reports shellAuth "token"', async () => {
            const h = await start({ shell: { token: TOKEN } });
            expect(await capabilities(h)).toMatchObject({ shell: true, shellAuth: 'token' });
        });

        it('missing token => 4401, wrong token => 4403', async () => {
            const h = await start({ shell: { token: TOKEN } });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell?cmd=id')).toEqual({ code: 4401, reason: 'login required' });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell?cmd=id', bearer('nope'))).toEqual({ code: 4403, reason: 'invalid token' });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell?cmd=id', bearer(TOKEN + 'x'))).toMatchObject({ code: 4403 });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell?cmd=id', { Authorization: TOKEN })).toMatchObject({ code: 4401 });
            const q = encodeURIComponent('Bearer wrong');
            expect(await closeOf(h.port, `/ws/v1/qcli/shell?cmd=id&_header_Authorization=${q}`)).toMatchObject({ code: 4403 });
        });

        it('accepts the Authorization header', async () => {
            const h = await start({ shell: { token: TOKEN } });
            expect(await run(h.port, 'echo via-header', bearer(TOKEN))).toContain('via-header');
            expect(await run(h.port, 'echo lower-scheme', { Authorization: `bearer ${TOKEN}` })).toContain('lower-scheme');
        });

        it('accepts the _header_Authorization query parameter (browser clients)', async () => {
            const h = await start({ shell: { token: TOKEN } });
            const q = `&_header_Authorization=${encodeURIComponent(`Bearer ${TOKEN}`)}`;
            expect(await run(h.port, 'echo via-query', {}, q)).toContain('via-query');
        });

        it('compares in constant time (sha256 + timingSafeEqual, any length)', () => {
            expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
            expect(tokensEqual('a', TOKEN)).toBe(false);
            expect(tokensEqual(TOKEN + TOKEN, TOKEN)).toBe(false);
            expect(tokensEqual('', TOKEN)).toBe(false);
        });

        it('never logs the token', async () => {
            const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
            try {
                const h = await start({ shell: { token: TOKEN } });
                await run(h.port, 'true', bearer(TOKEN));
                await closeOf(h.port, '/ws/v1/qcli/shell', bearer('bad-token-value'));
                const logged = spies.flatMap((s) => s.mock.calls.map((c) => format(...c))).join('\n');
                expect(logged).not.toContain(TOKEN);
                expect(logged).not.toContain('bad-token-value');
                expect(logged).toMatch(/Shell opened \(id=.*auth=token/);
            } finally {
                spies.forEach((s) => s.mockRestore());
            }
        });

        it('takes precedence over authorize and allowAnonymous', async () => {
            const authorize = vi.fn(() => true);
            const h = await start({ shell: { token: TOKEN, authorize, allowAnonymous: true } });
            expect(await capabilities(h)).toMatchObject({ shellAuth: 'token' });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell?cmd=id')).toMatchObject({ code: 4401 });
            expect(authorize).not.toHaveBeenCalled();
        });
    });

    describe('authorize (custom) mode', () => {
        it('reports shellAuth "custom" and passes request + context', async () => {
            const authorize = vi.fn((req: http.IncomingMessage) => req.headers['x-shell-key'] === 'ok');
            const h = await start({ shell: { authorize, allowAnonymous: true } });
            expect(await capabilities(h)).toMatchObject({ shell: true, shellAuth: 'custom' });
            expect(await run(h.port, 'echo custom-ok', { 'x-shell-key': 'ok' })).toContain('custom-ok');
            const [req, ctx] = authorize.mock.calls[0] as unknown as [http.IncomingMessage, any];
            expect(req.headers['x-shell-key']).toBe('ok');
            expect(ctx.remoteAddress).toMatch(/127\.0\.0\.1/);
            expect(ctx.mode).toBe('command');
            expect(ctx.url.searchParams.get('cmd')).toBe('echo custom-ok');
        });

        it('false => 4403', async () => {
            const h = await start({ shell: { authorize: () => false } });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell')).toEqual({ code: 4403, reason: 'permission denied' });
        });

        it('async check is awaited', async () => {
            const h = await start({ shell: { authorize: async () => { await sleep(20); return true; } } });
            expect(await run(h.port, 'echo async-ok')).toContain('async-ok');
        });

        it('exceptions and rejections deny (4403)', async () => {
            const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                const h1 = await start({ shell: { authorize: () => { throw new Error('boom'); } } });
                expect(await closeOf(h1.port, '/ws/v1/qcli/shell')).toEqual({ code: 4403, reason: 'permission denied' });
                const h2 = await start({ shell: { authorize: () => Promise.reject(new Error('nope')) } });
                expect(await closeOf(h2.port, '/ws/v1/qcli/shell')).toEqual({ code: 4403, reason: 'permission denied' });
                const h3 = await start({ shell: { authorize: (() => 'yes') as any } });
                expect(await closeOf(h3.port, '/ws/v1/qcli/shell')).toMatchObject({ code: 4403 });
            } finally {
                warns.mockRestore();
            }
        });
    });

    describe('users mode', () => {
        let h: Harness;
        let app: express.Express;
        let root: { token: string; sessionId: string; userId: string };
        let plain: { token: string; sessionId: string; userId: string };

        const setup = async (shell?: CliShellOptions) => {
            h = await start({ users: true, shell });
            app = h.cli.app;
            root = await login(app, 'root', ROOT_PASS);
            await request(app).post(`${V1}/users`).set(bearer(root.token)).send({ name: 'plain', email: 'plain@x.io', password: 'plainpass' }).expect(201);
            plain = await login(app, 'plain', 'plainpass');
        };

        it('applies when the users plugin is mounted (even with token/anonymous configured)', async () => {
            await setup({ allowAnonymous: true });
            expect(await capabilities(h)).toMatchObject({ shell: true, shellAuth: 'users' });
        });

        it('needs a ticket (4401) and shell:execute (4403); root (*) gets a shell', async () => {
            await setup();
            expect(await closeOf(h.port, '/ws/v1/qcli/shell')).toEqual({ code: 4401, reason: 'login required' });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell?ticket=bogus')).toEqual({ code: 4401, reason: 'login required' });
            expect(await closeOf(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(app, plain.token)}`)).toEqual({
                code: 4403,
                reason: 'permission denied',
            });
            expect(await run(h.port, 'echo root-ok', {}, `&ticket=${await ticket(app, root.token)}`)).toContain('root-ok');
        });

        it('a configured token is required in addition (both must pass)', async () => {
            await setup({ token: TOKEN });
            expect(await capabilities(h)).toMatchObject({ shellAuth: 'users' });
            expect(await closeOf(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(app, root.token)}`)).toEqual({
                code: 4401,
                reason: 'login required',
            });
            expect(await closeOf(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(app, root.token)}`, bearer('bad'))).toMatchObject({ code: 4403 });
            expect(await closeOf(h.port, '/ws/v1/qcli/shell', bearer(TOKEN))).toMatchObject({ code: 4401 });
            expect(await run(h.port, 'echo both-ok', bearer(TOKEN), `&ticket=${await ticket(app, root.token)}`)).toContain('both-ok');
        });

        it('a configured authorize is required in addition', async () => {
            await setup({ authorize: (req) => req.headers['x-ok'] === '1' });
            expect(await closeOf(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(app, root.token)}`)).toMatchObject({ code: 4403 });
            expect(await run(h.port, 'echo auth-ok', { 'x-ok': '1' }, `&ticket=${await ticket(app, root.token)}`)).toContain('auth-ok');
        });
    });
});

// ---------------------------------------------------------------------------
// C2 — session binding (users mode)
// ---------------------------------------------------------------------------

describe('C2: session binding', () => {
    let h: Harness;
    let app: express.Express;
    let root: { token: string; sessionId: string; userId: string };

    const shellFor = async (token: string) => {
        const c = open(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(app, token)}`);
        await c.ready;
        return c;
    };

    const setupShellUser = async () => {
        await request(app).post(`${V1}/groups`).set(bearer(root.token)).send({ name: 'shellers', permissions: ['shell:execute'] }).expect(201);
        await request(app)
            .post(`${V1}/users`)
            .set(bearer(root.token))
            .send({ name: 'ops', email: 'ops@x.io', password: 'opspass1', groups: ['shellers'] })
            .expect(201);
        return login(app, 'ops', 'opspass1');
    };

    beforeAll(async () => {
        h = await start({ users: true, shell: { sessionCheckIntervalMs: 100 } });
        harnesses.pop(); // lives for the whole describe
        app = h.cli.app;
        root = await login(app, 'root', ROOT_PASS);
    });

    afterAll(async () => {
        await stop(h);
    });

    it('logout closes the shell with 4401 "session ended"', async () => {
        const s = await login(app, 'root', ROOT_PASS);
        const c = await shellFor(s.token);
        await request(app).delete(`${V1}/sessions/current`).set(bearer(s.token)).expect(204);
        expect(await c.closed).toEqual({ code: 4401, reason: 'session ended' });
    });

    it('admin revoke (kick) closes the shell; other sessions keep theirs', async () => {
        const victim = await login(app, 'root', ROOT_PASS);
        const other = await login(app, 'root', ROOT_PASS);
        const c = await shellFor(victim.token);
        const keep = await shellFor(other.token);
        await request(app).delete(`${V1}/sessions/${victim.sessionId}`).set(bearer(root.token)).expect(204);
        expect(await c.closed).toEqual({ code: 4401, reason: 'session ended' });
        await sleep(150);
        expect(keep.ws.readyState).toBe(WebSocket.OPEN);
        keep.ws.close();
        await keep.closed;
    });

    it('losing shell:execute (removed from group) closes the shell', async () => {
        const ops = await setupShellUser();
        const c = await shellFor(ops.token);
        await request(app).delete(`${V1}/groups/shellers/members/ops`).set(bearer(root.token)).expect(204);
        expect(await c.closed).toEqual({ code: 4401, reason: 'session ended' });
        await request(app).delete(`${V1}/users/ops`).set(bearer(root.token)).expect(204);
        await request(app).delete(`${V1}/groups/shellers`).set(bearer(root.token)).expect(204);
    });

    it('periodic re-check catches permission changes made behind the API', async () => {
        const ops = await setupShellUser();
        const c = await shellFor(ops.token);
        await h.users!.groupStore.updateGroup('shellers', { permissions: ['commands:execute'] });
        expect(await c.closed).toEqual({ code: 4401, reason: 'session ended' });
        await request(app).delete(`${V1}/users/ops`).set(bearer(root.token)).expect(204);
        await request(app).delete(`${V1}/groups/shellers`).set(bearer(root.token)).expect(204);
    });

    it('disabling or deleting the user closes the shell', async () => {
        const ops = await setupShellUser();
        const c1 = await shellFor(ops.token);
        await request(app).put(`${V1}/users/ops`).set(bearer(root.token)).send({ disabled: true }).expect(200);
        expect(await c1.closed).toEqual({ code: 4401, reason: 'session ended' });

        await request(app).put(`${V1}/users/ops`).set(bearer(root.token)).send({ disabled: false }).expect(200);
        const ops2 = await login(app, 'ops', 'opspass1');
        const c2 = await shellFor(ops2.token);
        await request(app).delete(`${V1}/users/ops`).set(bearer(root.token)).expect(204);
        expect(await c2.closed).toEqual({ code: 4401, reason: 'session ended' });
        await request(app).delete(`${V1}/groups/shellers`).set(bearer(root.token)).expect(204);
    });

    it('session expiry closes the shell (checked periodically)', async () => {
        const e = await start({ users: true, shell: { sessionCheckIntervalMs: 50 }, configureUsers: (b) => b.setMaxSessionLifetime(600) });
        const s = await login(e.cli.app, 'root', ROOT_PASS);
        const c = open(e.port, `/ws/v1/qcli/shell?ticket=${await ticket(e.cli.app, s.token)}`);
        await c.ready;
        const t0 = Date.now();
        expect(await c.closed).toEqual({ code: 4401, reason: 'session ended' });
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('kills the process tree when the session ends', async () => {
        if (os.platform() !== 'linux') return;
        const s = await login(app, 'root', ROOT_PASS);
        const c = open(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(app, s.token)}&cmd=${encodeURIComponent('sleep 300 & echo CHILD:$!; wait')}`);
        await waitFor(() => /CHILD:\d+/.test(c.output()));
        const child = Number(/CHILD:(\d+)/.exec(c.output())![1]);
        expect(processDead(child)).toBe(false);
        await request(app).delete(`${V1}/sessions/${s.sessionId}`).set(bearer(root.token)).expect(204);
        expect((await c.closed).code).toBe(4401);
        await waitFor(() => processDead(child));
    });
});

// ---------------------------------------------------------------------------
// C3 — limits and environment
// ---------------------------------------------------------------------------

describe('C3: limits', () => {
    it('maxSessionsPerUser (users mode) => 4429; other users unaffected', async () => {
        const h = await start({ users: true, shell: { maxSessionsPerUser: 2 } });
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        const a = open(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(h.cli.app, root.token)}`);
        const b = open(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(h.cli.app, root.token)}`);
        await Promise.all([a.ready, b.ready]);
        expect(await closeOf(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(h.cli.app, root.token)}`)).toEqual({
            code: 4429,
            reason: 'too many shell sessions',
        });

        await request(h.cli.app).post(`${V1}/users`).set(bearer(root.token)).send({ name: 'admin2', email: 'a2@x.io', password: 'admin2pass', groups: ['admin'] }).expect(201);
        const other = await login(h.cli.app, 'admin2', 'admin2pass');
        const c = open(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(h.cli.app, other.token)}`);
        await c.ready;

        // A slot frees up when a shell closes
        a.ws.close();
        await a.closed;
        await waitFor(() => h.cli.eventSocketManager.shellManager.getSessions().length === 2);
        const d = open(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(h.cli.app, root.token)}`);
        await d.ready;
        expect(h.cli.eventSocketManager.shellManager.getSessions().map((s) => s.userName).sort()).toEqual(['admin2', 'root', 'root']);
    });

    it('per remote address in token mode, and the global maxSessions cap', async () => {
        const h = await start({ shell: { token: TOKEN, maxSessionsPerUser: 1, maxSessions: 5 } });
        const a = open(h.port, '/ws/v1/qcli/shell', bearer(TOKEN));
        await a.ready;
        expect(await closeOf(h.port, '/ws/v1/qcli/shell', bearer(TOKEN))).toEqual({ code: 4429, reason: 'too many shell sessions' });

        const g = await start({ shell: { allowAnonymous: true, maxSessionsPerUser: 10, maxSessions: 2 } });
        const x = open(g.port, '/ws/v1/qcli/shell');
        const y = open(g.port, '/ws/v1/qcli/shell');
        await Promise.all([x.ready, y.ready]);
        expect(await closeOf(g.port, '/ws/v1/qcli/shell')).toEqual({ code: 4429, reason: 'too many shell sessions' });
    });

    it('defaults: 3 per user, 20 total', async () => {
        const h = await start({ shell: { allowAnonymous: true } });
        const conns = [open(h.port, '/ws/v1/qcli/shell'), open(h.port, '/ws/v1/qcli/shell'), open(h.port, '/ws/v1/qcli/shell')];
        await Promise.all(conns.map((c) => c.ready));
        expect((await closeOf(h.port, '/ws/v1/qcli/shell')).code).toBe(4429);
    });
});

describe('C3: timeouts', () => {
    it('idle timeout (no stdin) => 4408 "shell timed out"', async () => {
        const h = await start({ shell: { allowAnonymous: true, idleTimeoutMs: 300 } });
        const c = open(h.port, '/ws/v1/qcli/shell');
        await c.ready;
        const t0 = Date.now();
        expect(await c.closed).toEqual({ code: 4408, reason: 'shell timed out' });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    });

    it('stdin keeps the shell alive', async () => {
        const h = await start({ shell: { allowAnonymous: true, idleTimeoutMs: 300 } });
        const c = open(h.port, '/ws/v1/qcli/shell');
        await c.ready;
        for (let i = 0; i < 6; i++) {
            c.ws.send(JSON.stringify({ type: 'stdin', data: ' ' }));
            await sleep(100);
        }
        expect(c.ws.readyState).toBe(WebSocket.OPEN);
        expect(await c.closed).toEqual({ code: 4408, reason: 'shell timed out' });
    });

    it('maxDuration closes even an active shell', async () => {
        const h = await start({ shell: { allowAnonymous: true, idleTimeoutMs: 10_000, maxDurationMs: 400 } });
        const c = open(h.port, '/ws/v1/qcli/shell');
        await c.ready;
        const keepAlive = setInterval(() => c.ws.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify({ type: 'stdin', data: ' ' })), 50);
        try {
            expect(await c.closed).toEqual({ code: 4408, reason: 'shell timed out' });
        } finally {
            clearInterval(keepAlive);
        }
    });
});

describe('C3: environment, cwd, shell', () => {
    const saved = { ...process.env };
    afterAll(() => {
        for (const k of ['SECRET_X', 'ALLOWED_X']) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('the shell gets a minimal environment: server secrets do not leak', async () => {
        process.env.SECRET_X = 'super-secret-value';
        process.env.ALLOWED_X = 'allowed-value';
        const h = await start({ shell: { allowAnonymous: true, env: { allow: ['ALLOWED_X'], set: { FOO_SET: 'bar' } } } });
        const out = await run(h.port, 'env');
        expect(out).not.toContain('SECRET_X');
        expect(out).not.toContain('super-secret-value');
        expect(out).toContain('ALLOWED_X=allowed-value');
        expect(out).toContain('FOO_SET=bar');
        expect(out).toMatch(/PATH=/);
        expect(out).toMatch(/TERM=xterm-256color/);
        expect(out).toMatch(/HOME=/);

        const names = out
            .split(/\r?\n/)
            .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1])
            .filter(Boolean) as string[];
        const allowed = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'COLUMNS', 'LINES', 'SHELL', 'ALLOWED_X', 'FOO_SET',
            // set by the shell itself
            'PWD', 'SHLVL', '_', 'OLDPWD']);
        expect(names.filter((n) => !allowed.has(n))).toEqual([]);
    });

    it('buildShellEnv: base names only, allow-list, set wins', () => {
        const env = buildShellEnv(
            { allow: ['KEEP'], set: { TERM: 'dumb', EXTRA: '1' } },
            { shell: '/bin/sh', cols: 100, rows: 30 },
            { PATH: '/bin', HOME: '/h', DB_PASSWORD: 'x', KEEP: 'k', LANG: 'C' },
        );
        expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', KEEP: 'k', LANG: 'C', TERM: 'dumb', EXTRA: '1', SHELL: '/bin/sh', COLUMNS: '100', LINES: '30' });
        expect(env).not.toHaveProperty('DB_PASSWORD');
    });

    it('cwd and shell options', async () => {
        const dir = fs.realpathSync(os.tmpdir());
        const h = await start({ shell: { allowAnonymous: true, cwd: dir, shell: '/bin/sh' } });
        const c = open(h.port, `/ws/v1/qcli/shell?cmd=${encodeURIComponent('pwd; echo SH:$0')}`);
        await c.ready;
        expect(c.messages.find((m) => m.type === 'ready')).toMatchObject({ shell: 'sh' });
        expect((await c.closed).code).toBe(1000);
        expect(c.output()).toContain(dir);
        expect(c.output()).toContain('SH:/bin/sh');
    });
});

// ---------------------------------------------------------------------------
// C4 — audit and logging
// ---------------------------------------------------------------------------

describe('C4: audit', () => {
    it('users mode audits shell_opened / shell_closed without command text or stdin', async () => {
        const h = await start({ users: true });
        const root = await login(h.cli.app, 'root', ROOT_PASS);

        await run(h.port, 'echo CMD_MARKER_42; exit 3', {}, `&ticket=${await ticket(h.cli.app, root.token)}`).catch(() => undefined);

        const c = open(h.port, `/ws/v1/qcli/shell?ticket=${await ticket(h.cli.app, root.token)}`);
        await c.ready;
        c.ws.send(JSON.stringify({ type: 'stdin', data: 'echo STDIN_MARKER_77\n' }));
        await waitFor(() => c.output().includes('STDIN_MARKER_77'));
        c.ws.close();
        await c.closed;

        let entries: any[] = [];
        await waitFor(() => {
            void h.users!.auditStore.getEntries().then((e) => (entries = e));
            return entries.filter((e) => e.event === 'shell_closed').length === 2;
        });
        const shell = entries.filter((e) => e.event.startsWith('shell_')).sort((a, b) => a.timestamp - b.timestamp);
        expect(shell.map((e) => e.event).sort()).toEqual(['shell_closed', 'shell_closed', 'shell_opened', 'shell_opened']);
        for (const e of shell) {
            expect(e).toMatchObject({ username: 'root', userId: root.userId, actorId: root.userId });
            expect(e.metadata.sessionId).toBe(root.sessionId);
        }
        const cmdClosed = shell.find((e) => e.event === 'shell_closed' && e.metadata.mode === 'command');
        expect(cmdClosed.metadata).toMatchObject({ mode: 'command', exitCode: 3, reason: 'exit' });
        expect(typeof cmdClosed.metadata.durationMs).toBe('number');
        const interactiveClosed = shell.find((e) => e.event === 'shell_closed' && e.metadata.mode === 'interactive');
        expect(interactiveClosed.metadata).toMatchObject({ mode: 'interactive', reason: 'client closed' });

        const text = JSON.stringify(entries);
        expect(text).not.toContain('CMD_MARKER_42');
        expect(text).not.toContain('STDIN_MARKER_77');
    });

    it('other modes log one line per open/close with remote address and mode, never the command', async () => {
        const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            const h = await start({ shell: { token: TOKEN } });
            await run(h.port, 'echo LOGCMD_MARKER', bearer(TOKEN));
            await sleep(50);
            const lines = logs.mock.calls.map((c) => format(...c)).filter((l) => /Shell (opened|closed)/.test(l));
            expect(lines).toHaveLength(2);
            for (const l of lines) {
                expect(l).toMatch(/auth=token/);
                expect(l).toMatch(/mode=command/);
                expect(l).toMatch(/remote=.*127\.0\.0\.1/);
                expect(l).not.toContain('LOGCMD_MARKER');
            }
        } finally {
            logs.mockRestore();
        }
    });
});

// ---------------------------------------------------------------------------
// C5 — origin rejection may stay HTTP 403
// ---------------------------------------------------------------------------

describe('C5: origin', () => {
    it('rejects a foreign Origin with HTTP 403 before accepting', async () => {
        const cli = createCliServer({ enableShell: true, allowedOrigins: ['http://localhost:4300'], shell: { allowAnonymous: true } });
        const server = http.createServer(cli.app);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        cli.eventSocketManager.attach(server);
        harnesses.push({ cli, server, port: (server.address() as AddressInfo).port });
        const port = (server.address() as AddressInfo).port;
        expect(await closeOf(port, '/ws/v1/qcli/shell', { Origin: 'https://evil.example' })).toEqual({ code: -403, reason: '' });
        const ok = open(port, '/ws/v1/qcli/shell', { Origin: 'http://localhost:4300' });
        await ok.ready;
    });
});
