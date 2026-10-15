/**
 * Regression tests for bugs found while reviewing the users plugin / remote
 * shell security branch.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { PassThrough } from 'stream';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliShellOptions } from '../services/cli-shell-options';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';

const V1 = '/api/v1/qcli';
const ROOT_PASS = 'rootpass1';

interface Harness {
    cli: CliServerResult;
    users?: UsersPluginResult;
    server: http.Server;
    port: number;
}

const harnesses: Harness[] = [];

async function start(opts: { shell?: CliShellOptions; users?: boolean } = {}): Promise<Harness> {
    const cli = createCliServer({ enableShell: true, shell: opts.shell });
    let users: UsersPluginResult | undefined;
    if (opts.users) {
        users = new CliUsersBuilder()
            .setDefaultAdminPassword(ROOT_PASS)
            .setIpRateLimit(10_000)
            .build((msg) => cli.eventSocketManager.broadcastMessage(msg));
        await users.ready;
        cli.mountPlugin(users);
    }
    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(server);
    cli.logSocketManager.attach(server);
    const h = { cli, users, server, port: (server.address() as AddressInfo).port };
    harnesses.push(h);
    return h;
}

afterEach(async () => {
    while (harnesses.length) {
        const h = harnesses.pop()!;
        h.cli.eventSocketManager.dispose();
        h.cli.logSocketManager.dispose();
        h.users?.dispose();
        h.server.closeAllConnections?.();
        await new Promise<void>((r) => h.server.close(() => r()));
    }
});

function openShell(port: number, path: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    let readyResolve!: () => void;
    const ready = new Promise<void>((r) => (readyResolve = r));
    ws.on('message', (raw) => {
        if (JSON.parse(raw.toString()).type === 'ready') readyResolve();
    });
    ws.on('error', () => undefined);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    return { ws, ready, closed };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function login(app: express.Express, username: string, password: string): Promise<string> {
    const res = await request(app).post(`${V1}/sessions`).send({ username, password });
    if (res.status !== 201) throw new Error(`login failed ${res.status}`);
    return res.body.token;
}

describe('WebSocket upgrade with a malformed request URL', () => {
    it.each(['//[', 'http://[::1', '//:99999'])('does not throw from the upgrade listener (%s)', async (url) => {
        const h = await start();
        const socket = new PassThrough();
        const req = Object.assign(new PassThrough(), { url, headers: {}, method: 'GET', socket }) as unknown as http.IncomingMessage;
        expect(() => h.server.emit('upgrade', req, socket, Buffer.alloc(0))).not.toThrow();
        socket.destroy();
    });
});

describe('POST /execute with a malformed command', () => {
    it.each([
        ['missing command', {}],
        ['non-string command', { command: 42 }],
    ])('answers 400 instead of an unhandled rejection (%s)', async (_name, body) => {
        const cli = createCliServer({
            configure: (b) =>
                b.addProcessor({ command: 'echo', description: 'echo', author: DefaultLibraryAuthor, version: '1.0.0', handleAsync: async () => 'ok' }),
        });
        const res = await request(cli.app).post(`${V1}/execute`).send(body).timeout(2000);
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });
});

describe('shell timers longer than the setTimeout limit (~24.8 days)', () => {
    it('a long maxDurationMs / idleTimeoutMs does not close the shell immediately', async () => {
        const day = 24 * 60 * 60 * 1000;
        const h = await start({ shell: { allowAnonymous: true, maxDurationMs: 30 * day, idleTimeoutMs: 30 * day } });
        const c = openShell(h.port, '/ws/v1/qcli/shell');
        await c.ready;
        await sleep(300);
        expect(c.ws.readyState).toBe(WebSocket.OPEN);
        c.ws.close();
        await c.closed;
    });
});

describe('group permission changes re-check open shells immediately', () => {
    const setup = async () => {
        const h = await start({ users: true, shell: { sessionCheckIntervalMs: 60_000 } });
        const app = h.cli.app;
        const root = await login(app, 'root', ROOT_PASS);
        await request(app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'shellers', permissions: ['shell:execute'] }).expect(201);
        await request(app)
            .post(`${V1}/users`)
            .set(bearer(root))
            .send({ name: 'ops', email: 'ops@x.io', password: 'opspass1', groups: ['shellers'] })
            .expect(201);
        const ops = await login(app, 'ops', 'opspass1');
        const t = await request(app).post(`${V1}/sessions/ws-ticket`).set(bearer(ops)).expect(201);
        const c = openShell(h.port, `/ws/v1/qcli/shell?ticket=${t.body.ticket}`);
        await c.ready;
        return { app, root, c };
    };

    const closedWithin = (c: { closed: Promise<{ code: number; reason: string }> }, ms: number) =>
        Promise.race([c.closed, sleep(ms).then(() => 'still open' as const)]);

    it('removing shell:execute from a group closes its members\' shells', async () => {
        const { app, root, c } = await setup();
        await request(app).put(`${V1}/groups/shellers`).set(bearer(root)).send({ permissions: ['commands:execute'] }).expect(200);
        expect(await closedWithin(c, 2000)).toEqual({ code: 4401, reason: 'session ended' });
    });

    it('deleting a group closes its members\' shells', async () => {
        const { app, root, c } = await setup();
        await request(app).delete(`${V1}/groups/shellers`).set(bearer(root)).expect(204);
        expect(await closedWithin(c, 2000)).toEqual({ code: 4401, reason: 'session ended' });
    });
});

describe('stdin in the same millisecond as a session re-check', () => {
    it('still counts as session activity at the next re-check', async () => {
        const h = await start({ users: true, shell: { sessionCheckIntervalMs: 60_000 } });
        const app = h.cli.app;
        const root = await login(app, 'root', ROOT_PASS);
        const t = await request(app).post(`${V1}/sessions/ws-ticket`).set(bearer(root)).expect(201);
        const c = openShell(h.port, `/ws/v1/qcli/shell?ticket=${t.body.ticket}`);
        await c.ready;
        const touch = vi.spyOn(h.users!.serverAuth, 'touch');
        const manager = h.cli.eventSocketManager.shellManager;

        // A re-check and a keystroke land in the same millisecond, the keystroke after the check
        const frozen = Date.now() + 5;
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(frozen);
        try {
            await manager.recheck();
            c.ws.send(JSON.stringify({ type: 'stdin', data: ' ' }));
            await sleep(100);
        } finally {
            nowSpy.mockRestore();
        }
        expect(touch).not.toHaveBeenCalled();

        await sleep(5);
        await manager.recheck();
        expect(touch).toHaveBeenCalledTimes(1);
        c.ws.close();
        await c.closed;
    });
});
