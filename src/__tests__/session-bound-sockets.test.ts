/**
 * Events and logs sockets authenticated with a stored session are bound to it:
 * when the session ends (logout, revoke, user disabled/deleted, expiry) the
 * socket closes with 4401 `session ended`; for a revoke `session-kicked` is
 * sent first. Adapter identities have no stored session and are not re-checked.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult, User, AuthAdapter } from '../../plugins/users/index';

const ORIGIN = 'http://localhost:4300';
const ROOT_PASS = 'rootpass1';
const V1 = '/api/v1/qcli';

interface Harness {
    cli: CliServerResult;
    users: UsersPluginResult;
    server: http.Server;
    port: number;
}

let current: Harness | undefined;

async function start(configure: (b: CliUsersBuilder) => CliUsersBuilder = (b) => b): Promise<Harness> {
    const cli = createCliServer({ allowedOrigins: [ORIGIN] });
    const users = configure(new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000)).build((msg) =>
        cli.eventSocketManager.broadcastMessage(msg),
    );
    await users.ready;
    cli.mountPlugin(users);
    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(server);
    cli.logSocketManager.attach(server);
    current = { cli, users, server, port: (server.address() as AddressInfo).port };
    return current;
}

afterEach(async () => {
    const h = current;
    current = undefined;
    if (!h) return;
    h.cli.eventSocketManager.dispose();
    h.cli.logSocketManager.dispose();
    h.users.dispose();
    await new Promise<void>((r) => h.server.close(() => r()));
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function login(app: express.Express, username: string, password: string) {
    const res = await request(app).post(`${V1}/sessions`).send({ username, password });
    if (res.status !== 201) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
    return { token: res.body.token as string, sessionId: res.body.session.id as string, userId: res.body.session.user.id as string };
}

async function ticket(app: express.Express, token: string): Promise<string> {
    const res = await request(app).post(`${V1}/sessions/ws-ticket`).set(bearer(token));
    expect(res.status).toBe(201);
    return res.body.ticket;
}

interface Conn {
    ws: WebSocket;
    messages: any[];
    /** Messages received before the close (in order), then the close. */
    closed: Promise<{ code: number; reason: string; messages: any[] }>;
}

function open(port: number, path: string, headers: Record<string, string> = {}): Promise<Conn> {
    return new Promise((resolve, reject) => {
        const messages: any[] = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        const closed = new Promise<{ code: number; reason: string; messages: any[] }>((r) =>
            ws.on('close', (code, reason) => r({ code, reason: reason.toString(), messages: [...messages] })),
        );
        ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
        ws.on('open', () => resolve({ ws, messages, closed }));
        ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)));
        ws.on('error', () => undefined);
    });
}

const within = <T>(p: Promise<T>, ms = 2000): Promise<T | 'open'> =>
    Promise.race([p, new Promise<'open'>((r) => setTimeout(() => r('open'), ms))]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sockets(h: Harness, token: string) {
    const events = await open(h.port, `/ws/v1/qcli/events?ticket=${await ticket(h.cli.app, token)}`);
    const logs = await open(h.port, `/ws/v1/qcli/logs?ticket=${await ticket(h.cli.app, token)}`);
    return { events, logs };
}

const ENDED = { code: 4401, reason: 'session ended' };
const kicks = (m: any[]) => m.filter((x) => x.type === 'session-kicked');

describe('events/logs sockets are bound to their session', () => {
    it('logout closes both sockets with 4401 "session ended" (no session-kicked)', async () => {
        const h = await start();
        const s = await login(h.cli.app, 'root', ROOT_PASS);
        const other = await login(h.cli.app, 'root', ROOT_PASS);
        const mine = await sockets(h, s.token);
        const theirs = await sockets(h, other.token);

        await request(h.cli.app).delete(`${V1}/sessions/current`).set(bearer(s.token)).expect(204);

        const ev = await within(mine.events.closed);
        expect(ev).toMatchObject(ENDED);
        expect(kicks((ev as any).messages)).toEqual([]);
        expect(await within(mine.logs.closed)).toMatchObject(ENDED);

        // Sockets of other sessions stay open
        await sleep(50);
        expect(theirs.events.ws.readyState).toBe(WebSocket.OPEN);
        expect(theirs.logs.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('revoke sends session-kicked to the events socket first, then closes both with "session ended"', async () => {
        const h = await start();
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        const victim = await login(h.cli.app, 'root', ROOT_PASS);
        const v = await sockets(h, victim.token);

        await request(h.cli.app).delete(`${V1}/sessions/${victim.sessionId}`).set(bearer(root.token)).expect(204);

        const ev = await within(v.events.closed);
        expect(ev).toMatchObject(ENDED);
        expect(kicks((ev as any).messages)).toEqual([
            { type: 'session-kicked', data: { sessionId: victim.sessionId, userId: victim.userId, reason: 'revoked' } },
        ]);
        expect(await within(v.logs.closed)).toMatchObject(ENDED);
    });

    for (const action of ['disabled', 'deleted'] as const) {
        it(`user ${action}: session-kicked first, then both sockets close with "session ended"`, async () => {
            const h = await start();
            const root = await login(h.cli.app, 'root', ROOT_PASS);
            await request(h.cli.app)
                .post(`${V1}/users`)
                .set(bearer(root.token))
                .send({ name: 'ops', email: 'ops@x.io', password: 'opspass1', groups: ['admin'] })
                .expect(201);
            const ops = await login(h.cli.app, 'ops', 'opspass1');
            const o = await sockets(h, ops.token);

            if (action === 'disabled') {
                await request(h.cli.app).put(`${V1}/users/${ops.userId}`).set(bearer(root.token)).send({ disabled: true }).expect(200);
            } else {
                await request(h.cli.app).delete(`${V1}/users/${ops.userId}`).set(bearer(root.token)).expect(204);
            }

            const ev = await within(o.events.closed);
            expect(ev).toMatchObject(ENDED);
            expect(kicks((ev as any).messages)).toEqual([
                { type: 'session-kicked', data: { sessionId: ops.sessionId, userId: ops.userId, reason: `user ${action}` } },
            ]);
            expect(await within(o.logs.closed)).toMatchObject(ENDED);
        });
    }

    it('the expiry sweep closes sockets of expired sessions (no session-kicked)', async () => {
        const h = await start((b) => b.setMaxSessionLifetime(600).setCleanupInterval(50));
        const s = await login(h.cli.app, 'root', ROOT_PASS);
        const mine = await sockets(h, s.token);

        const ev = await within(mine.events.closed, 3000);
        expect(ev).toMatchObject(ENDED);
        expect(kicks((ev as any).messages)).toEqual([]);
        expect(await within(mine.logs.closed, 3000)).toMatchObject(ENDED);
    });

    it('sockets of adapter identities (no stored session) are not re-checked', async () => {
        const ext: User = { id: 'ext-1', name: 'extuser', email: 'ext@host.io', groups: [], createdAt: 0, updatedAt: 0 };
        let hostSays: 'in' | 'out' = 'in';
        const adapter: AuthAdapter = (req) =>
            hostSays === 'in' && req.headers.cookie?.includes('sid=ok') ? { user: ext, isAdmin: true } : null;
        const h = await start((b) => b.setAuthAdapter(adapter).setCleanupInterval(50));
        const adapterTicket = async () => {
            const res = await request(h.cli.app).post(`${V1}/sessions/ws-ticket`).set('Cookie', 'sid=ok').set(bearer('host-jwt'));
            expect(res.status).toBe(201);
            return res.body.ticket as string;
        };
        const events = await open(h.port, `/ws/v1/qcli/events?ticket=${await adapterTicket()}`, { Cookie: 'sid=ok' });
        const logs = await open(h.port, `/ws/v1/qcli/logs?ticket=${await adapterTicket()}`, { Cookie: 'sid=ok' });

        hostSays = 'out';
        // A users change notification and several sweeps
        await h.users.authService.audit({ event: 'group_updated', username: 'root' });
        await sleep(300);
        expect(events.ws.readyState).toBe(WebSocket.OPEN);
        expect(logs.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('re-checks on users change notifications close sockets whose session ended silently', async () => {
        const h = await start();
        const s = await login(h.cli.app, 'root', ROOT_PASS);
        const mine = await sockets(h, s.token);
        // The session disappears from the store without a session event (e.g. an external store purge)
        await h.users.sessionStore.deleteSessionById(s.sessionId);
        await h.users.authService.audit({ event: 'group_updated', username: 'root' });

        expect(await within(mine.events.closed)).toMatchObject(ENDED);
        expect(await within(mine.logs.closed)).toMatchObject(ENDED);
    });
});

describe('server-wide events stop for a socket whose session ended', () => {
    it('no broadcast reaches a closed-by-session socket', async () => {
        const h = await start();
        const s = await login(h.cli.app, 'root', ROOT_PASS);
        const mine = await sockets(h, s.token);
        const spy = vi.fn();
        mine.events.ws.on('message', spy);
        await request(h.cli.app).delete(`${V1}/sessions/current`).set(bearer(s.token)).expect(204);
        h.cli.eventSocketManager.broadcastMessage({ type: 'hello' });
        await within(mine.events.closed);
        expect(spy.mock.calls.map((c) => JSON.parse(c[0].toString()).type)).not.toContain('hello');
    });
});
