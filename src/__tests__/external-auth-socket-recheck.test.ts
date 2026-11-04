/**
 * Events and logs sockets opened through an external auth adapter are
 * re-checked by running the adapter again on the request the identity came
 * from (the `POST /sessions/ws-ticket` request) every `sessionCheckIntervalMs`
 * (mirrors qodalis-solutions/cli-server-dotnet#25).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { effectiveSessionCheckIntervalMs } from '../services/cli-shell-options';
import { AuthAdapter, CliUsersBuilder, UsersPluginResult, User } from '../../plugins/users/index';

const ORIGIN = 'http://localhost:4300';
const V1 = '/api/v1/qcli';
const ENDED = { code: 4401, reason: 'session ended' };

/**
 * What the host says about each user: `admin` (`*`), `user` (no permissions),
 * `gone` (null), `other` (another user), `disabled`, `throw`.
 */
type HostStatus = 'admin' | 'user' | 'gone' | 'other' | 'disabled' | 'throw';
let host: Map<string, HostStatus>;
let calls: number;
let delayMs: number;

const user = (id: string, extra: Partial<User> = {}): User => ({
    id,
    name: id,
    email: `${id}@host.io`,
    groups: [],
    createdAt: 0,
    updatedAt: 0,
    ...extra,
});

/** Authenticates the `X-Host-User` header, which only the ticket request carries. */
const adapter: AuthAdapter = async (req) => {
    calls++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const id = req.headers['x-host-user'];
    if (typeof id !== 'string') return null;
    switch (host.get(id)) {
        case 'admin':
            return { user: user(id), isAdmin: true };
        case 'user':
            return { user: user(id) };
        case 'other':
            return { user: user(`${id}-impostor`), isAdmin: true };
        case 'disabled':
            return { user: user(id, { disabled: true }), isAdmin: true };
        case 'throw':
            throw new Error('host auth down');
        default:
            return null;
    }
};

interface Harness {
    cli: CliServerResult;
    users: UsersPluginResult;
    server: http.Server;
    port: number;
}

let current: Harness | undefined;

async function start(sessionCheckIntervalMs = 50): Promise<Harness> {
    host = new Map();
    calls = 0;
    delayMs = 0;
    const cli = createCliServer({ allowedOrigins: [ORIGIN], shell: { sessionCheckIntervalMs } });
    const users = new CliUsersBuilder().setAuthAdapter(adapter).build((msg) => cli.eventSocketManager.broadcastMessage(msg));
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
    h.server.closeAllConnections?.();
    await new Promise<void>((r) => h.server.close(() => r()));
});

async function ticket(h: Harness, id: string): Promise<string> {
    const res = await request(h.cli.app).post(`${V1}/sessions/ws-ticket`).set('X-Host-User', id).set('Origin', ORIGIN);
    expect(res.status).toBe(201);
    return res.body.ticket;
}

interface Conn {
    ws: WebSocket;
    closed: Promise<{ code: number; reason: string }>;
}

/** Opens a socket with a ticket; the upgrade itself carries no host credentials. */
async function open(h: Harness, path: 'events' | 'logs', id: string): Promise<Conn> {
    const t = await ticket(h, id);
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/v1/qcli/${path}?ticket=${t}`);
        const closed = new Promise<{ code: number; reason: string }>((r) =>
            ws.on('close', (code, reason) => r({ code, reason: reason.toString() })),
        );
        ws.on('open', () => resolve({ ws, closed }));
        ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)));
        ws.on('error', () => undefined);
    });
}

const within = <T>(p: Promise<T>, ms = 2000): Promise<T | 'open'> =>
    Promise.race([p, new Promise<'open'>((r) => setTimeout(() => r('open'), ms))]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('external-auth events/logs sockets are re-checked through the adapter', () => {
    for (const path of ['events', 'logs'] as const) {
        for (const status of ['gone', 'other', 'disabled', 'throw'] as const) {
            it(`${path} socket closes with 4401 "session ended" when the adapter says ${status}`, async () => {
                const h = await start();
                host.set('alice', 'admin');
                const c = await open(h, path, 'alice');
                await sleep(150);
                expect(c.ws.readyState).toBe(WebSocket.OPEN);

                host.set('alice', status);
                expect(await within(c.closed)).toEqual(ENDED);
            });
        }
    }

    it('logs socket closes once the user lost logs:read; the events socket only needs authentication', async () => {
        const h = await start();
        host.set('alice', 'admin');
        const events = await open(h, 'events', 'alice');
        const logs = await open(h, 'logs', 'alice');

        host.set('alice', 'user');
        expect(await within(logs.closed)).toEqual(ENDED);
        await sleep(200); // several more re-checks
        expect(events.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('logs socket stays open across re-checks while the host still authenticates the ticket request', async () => {
        const h = await start();
        host.set('alice', 'admin');
        const logs = await open(h, 'logs', 'alice');
        await sleep(400);
        expect(logs.ws.readyState).toBe(WebSocket.OPEN);
        // The upgrade request has no X-Host-User: the re-checks ran on the ticket request.
        expect(calls).toBeGreaterThan(3);
    });

    it('only the affected user’s sockets close', async () => {
        const h = await start();
        host.set('alice', 'admin');
        host.set('bob', 'admin');
        const alice = await open(h, 'events', 'alice');
        const bob = await open(h, 'events', 'bob');

        host.set('alice', 'gone');
        expect(await within(alice.closed)).toEqual(ENDED);
        await sleep(150);
        expect(bob.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('checks do not stack when the adapter is slower than the interval', async () => {
        const h = await start(20);
        host.set('alice', 'admin');
        const c = await open(h, 'events', 'alice');
        calls = 0;
        delayMs = 200;
        await sleep(450);
        // At most one check in flight at a time: ~2-3 calls in 450 ms, not ~20.
        expect(calls).toBeLessThanOrEqual(3);
        expect(c.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('the re-check interval is sessionCheckIntervalMs, capped at 60 s', () => {
        expect(effectiveSessionCheckIntervalMs(undefined)).toBe(30_000);
        expect(effectiveSessionCheckIntervalMs(5_000)).toBe(5_000);
        expect(effectiveSessionCheckIntervalMs(120_000)).toBe(60_000);
    });
});

describe('users the adapter returns disabled are refused', () => {
    it('on requests and ticket issuance (401 account disabled)', async () => {
        const h = await start();
        host.set('carol', 'disabled');
        for (const res of [
            await request(h.cli.app).get(`${V1}/commands`).set('X-Host-User', 'carol'),
            await request(h.cli.app).get(`${V1}/sessions/current`).set('X-Host-User', 'carol'),
            await request(h.cli.app).post(`${V1}/sessions/ws-ticket`).set('X-Host-User', 'carol').set('Origin', ORIGIN),
        ]) {
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ error: 'account disabled' });
        }
    });
});
