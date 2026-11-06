/**
 * Server events: the event bus (patterns, handler isolation, wire format), audience
 * delivery over a real events WebSocket, and each catalog event from its action.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliEventBus } from '../services/cli-event-bus';
import { withFileStorageEvents } from '../filesystem/file-storage-events';
import { ICliCommandProcessor } from '../abstractions';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import {
    CliEvent,
    ICliJob,
    cliEventBusFromBroadcast,
    cliEventPatternMatches,
    toCliEventMessage,
} from '@qodalis/cli-server-abstractions';
import { InMemoryFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { CliJobsBuilder, CliJobsPluginResult } from '@qodalis/cli-server-plugin-jobs';
import { CliAuditBuilder } from '@qodalis/cli-server-plugin-audit';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';

const ROOT_PASS = 'rootpass1';
const V1 = '/api/v1/qcli';
const MCP = '/api/qcli/mcp';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const waitFor = async (cond: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
    }
};

/** Records every event published on a bus. */
function record(bus: { subscribe(pattern: string, handler: (e: CliEvent) => void): () => void }, pattern = '*') {
    const events: CliEvent[] = [];
    const stop = bus.subscribe(pattern, (e) => {
        events.push(e);
    });
    return {
        events,
        stop,
        of: (type: string) => events.filter((e) => e.type === type),
        clear: () => events.splice(0, events.length),
    };
}

function connect(port: number, path: string): Promise<{ ws: WebSocket; messages: any[] }> {
    return new Promise((resolve, reject) => {
        const messages: any[] = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
        ws.on('open', () => resolve({ ws, messages }));
        ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
        ws.on('error', reject);
    });
}

async function listen(cli: CliServerResult): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(server);
    return { server, port: (server.address() as AddressInfo).port };
}

async function close(cli: CliServerResult, server: http.Server): Promise<void> {
    cli.eventSocketManager.dispose();
    await new Promise<void>((r) => server.close(() => r()));
}

function rpc(app: express.Express, method: string, params: unknown, headers: Record<string, string> = {}) {
    return request(app)
        .post(MCP)
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .set(headers)
        .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
}

async function callTool(app: express.Express, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
    const res = await rpc(app, 'tools/call', { name, arguments: args }, headers);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result?.isError).toBeFalsy();
    return res.body.result;
}

// ---------------------------------------------------------------------------
describe('event bus', () => {
    it('matches patterns: *, ns:* and exact types', () => {
        expect(cliEventPatternMatches('job:completed', '*')).toBe(true);
        expect(cliEventPatternMatches('job:completed', 'job:*')).toBe(true);
        expect(cliEventPatternMatches('job:runs-deleted', 'job:*')).toBe(true);
        expect(cliEventPatternMatches('jobs:completed', 'job:*')).toBe(false);
        expect(cliEventPatternMatches('job', 'job:*')).toBe(false);
        expect(cliEventPatternMatches('job:completed', 'job:completed')).toBe(true);
        expect(cliEventPatternMatches('job:completed', 'job:started')).toBe(false);
        expect(cliEventPatternMatches('job:completed', 'job')).toBe(false);
    });

    it('delivers to matching subscribers in subscription order and unsubscribes', async () => {
        const bus = new CliEventBus();
        const calls: string[] = [];
        bus.subscribe('*', (e) => void calls.push(`all:${e.type}`));
        const off = bus.subscribe('job:*', (e) => void calls.push(`jobs:${e.type}`));
        bus.subscribe('user:created', (e) => void calls.push(`exact:${e.type}`));
        await bus.publish('job:started', { jobId: 'a' });
        await bus.publish('user:created', { userId: 'u1' });
        off();
        await bus.publish('job:completed', { jobId: 'a' });
        expect(calls).toEqual(['all:job:started', 'jobs:job:started', 'all:user:created', 'exact:user:created', 'all:job:completed']);
    });

    it('isolates handler errors: publish resolves and the other handlers still run', async () => {
        const bus = new CliEventBus();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: string[] = [];
        bus.subscribe('*', () => {
            throw new Error('sync boom');
        });
        bus.subscribe('*', async () => {
            throw new Error('async boom');
        });
        bus.subscribe('*', (e) => void seen.push(e.type));
        await expect(bus.publish('fs:changed', { action: 'write', path: '/a' })).resolves.toBeUndefined();
        expect(seen).toEqual(['fs:changed']);
        expect(error).toHaveBeenCalledTimes(2);
        error.mockRestore();
    });

    it('waits for async handlers before publish resolves', async () => {
        const bus = new CliEventBus();
        let done = false;
        bus.subscribe('*', async () => {
            await new Promise((r) => setTimeout(r, 20));
            done = true;
        });
        await bus.publish('x:y');
        expect(done).toBe(true);
    });

    it('adds a timestamp unless the publisher set one; keeps the audience off the data', async () => {
        const bus = new CliEventBus();
        const r = record(bus);
        await bus.publish('job:started', { jobId: 'a' }, { permission: 'jobs:read' });
        await bus.publish('job:started', { jobId: 'b', timestamp: '2026-11-06T10:15:00.000Z' });
        await bus.publish('audit:recorded', { event: 'login', timestamp: Date.UTC(2026, 10, 6, 10, 15) });
        expect(r.events[0]).toEqual({ type: 'job:started', timestamp: expect.stringMatching(ISO), data: { jobId: 'a' }, audience: { permission: 'jobs:read' } });
        expect(r.events[1].timestamp).toBe('2026-11-06T10:15:00.000Z');
        expect(r.events[1].data).toEqual({ jobId: 'b' });
        expect(r.events[2].timestamp).toBe('2026-11-06T10:15:00.000Z');
    });

    it('wire format is flat: the publisher fields merged, type and timestamp reserved', () => {
        const message = toCliEventMessage({
            type: 'job:completed',
            timestamp: '2026-11-06T10:15:00.000Z',
            data: { jobId: 'cleanup', executionId: 'e1', duration: 1520, type: 'spoofed', timestamp: 'spoofed' },
        });
        expect(message).toEqual({ type: 'job:completed', timestamp: '2026-11-06T10:15:00.000Z', jobId: 'cleanup', executionId: 'e1', duration: 1520 });
    });

    it('a bus over a broadcast function sends the flat message and serves its own subscribers', async () => {
        const broadcast = vi.fn();
        const bus = cliEventBusFromBroadcast(broadcast);
        const r = record(bus, 'job:*');
        await bus.publish('job:paused', { jobId: 'a', status: 'paused' }, { permission: 'jobs:read' });
        expect(broadcast).toHaveBeenCalledWith({ type: 'job:paused', timestamp: expect.stringMatching(ISO), jobId: 'a', status: 'paused' });
        expect(r.of('job:paused')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe('audience over the events WebSocket', () => {
    it('an unprotected server delivers every event to every socket, flat', async () => {
        const cli = createCliServer({});
        const { server, port } = await listen(cli);
        try {
            const a = await connect(port, '/ws/v1/qcli/events');
            await cli.eventBus.publish('job:completed', { jobId: 'cleanup', executionId: 'e1', duration: 1520 }, { permission: 'jobs:read' });
            await cli.eventBus.publish('token:created', { tokenId: 't1' }, { userId: 'u1' });
            await cli.eventBus.publish('custom:ping', { n: 1 });
            await waitFor(() => a.messages.length >= 4);
            expect(a.messages[0]).toEqual({ type: 'connected' });
            expect(a.messages[1]).toEqual({ type: 'job:completed', timestamp: expect.stringMatching(ISO), jobId: 'cleanup', executionId: 'e1', duration: 1520 });
            expect(a.messages.slice(2).map((m) => m.type)).toEqual(['token:created', 'custom:ping']);
            a.ws.close();
        } finally {
            await close(cli, server);
        }
    });

    describe('protected server', () => {
        let cli: CliServerResult;
        let users: UsersPluginResult;
        let server: http.Server;
        let port: number;
        let root: { token: string; userId: string };
        let reader: { token: string; userId: string };
        let plain: { token: string; userId: string };

        const login = async (username: string, password: string) => {
            const res = await request(cli.app).post(`${V1}/sessions`).send({ username, password }).expect(201);
            return { token: res.body.token as string, userId: res.body.session.user.id as string };
        };
        const open = async (token: string) => {
            const res = await request(cli.app).post(`${V1}/sessions/ws-ticket`).set(bearer(token)).expect(201);
            return connect(port, `/ws/v1/qcli/events?ticket=${res.body.ticket}`);
        };

        beforeAll(async () => {
            cli = createCliServer({});
            users = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).build();
            await users.ready;
            cli.mountPlugin(users);
            ({ server, port } = await listen(cli));
            root = await login('root', ROOT_PASS);
            await request(cli.app).post(`${V1}/groups`).set(bearer(root.token)).send({ name: 'job-readers', permissions: ['jobs:read'] }).expect(201);
            await request(cli.app).post(`${V1}/users`).set(bearer(root.token)).send({ name: 'reader', email: 'reader@x.io', password: 'readerpass', groups: ['users', 'job-readers'] }).expect(201);
            await request(cli.app).post(`${V1}/users`).set(bearer(root.token)).send({ name: 'plain', email: 'plain@x.io', password: 'plainpass' }).expect(201);
            reader = await login('reader', 'readerpass');
            plain = await login('plain', 'plainpass');
        });
        afterAll(async () => {
            users.dispose();
            await close(cli, server);
        });

        it('delivers by permission, by user, by either, and to everyone without an audience', async () => {
            const sockets = { root: await open(root.token), reader: await open(reader.token), plain: await open(plain.token) };
            await waitFor(() => Object.values(sockets).every((s) => s.messages.length >= 1));

            await cli.eventBus.publish('test:permission', {}, { permission: 'jobs:read' });
            await cli.eventBus.publish('test:user', {}, { userId: plain.userId });
            await cli.eventBus.publish('test:either', {}, { permission: 'jobs:read', userId: plain.userId });
            await cli.eventBus.publish('test:user-only', {}, { userId: reader.userId });
            await cli.eventBus.publish('test:everyone', {});
            await new Promise((r) => setTimeout(r, 100));

            const types = (s: { messages: any[] }) => s.messages.map((m) => m.type).filter((t: string) => t.startsWith('test:'));
            expect(types(sockets.root)).toEqual(['test:permission', 'test:either', 'test:everyone']);
            expect(types(sockets.reader)).toEqual(['test:permission', 'test:either', 'test:user-only', 'test:everyone']);
            expect(types(sockets.plain)).toEqual(['test:user', 'test:either', 'test:everyone']);
            for (const s of Object.values(sockets)) s.ws.close();
        });

        it('in-process subscribers receive every event regardless of audience', async () => {
            const r = record(cli.eventBus, 'test:*');
            await cli.eventBus.publish('test:hidden', {}, { permission: 'nobody:has-this' });
            expect(r.of('test:hidden')).toHaveLength(1);
            r.stop();
        });

        it('raw broadcastMessage still works and filters namespaced messages by permission', async () => {
            const sockets = { reader: await open(reader.token), plain: await open(plain.token) };
            await waitFor(() => Object.values(sockets).every((s) => s.messages.length >= 1));
            cli.eventSocketManager.broadcastMessage({ type: 'job:started', jobId: 'x' });
            cli.eventSocketManager.broadcastMessage({ type: 'user:created', userId: 'x' });
            cli.eventSocketManager.broadcastMessage({ type: 'hello' });
            await new Promise((r) => setTimeout(r, 100));
            const types = (s: { messages: any[] }) => s.messages.map((m) => m.type).filter((t: string) => t !== 'connected');
            expect(types(sockets.reader)).toEqual(['job:started', 'hello']);
            expect(types(sockets.plain)).toEqual(['hello']);
            for (const s of Object.values(sockets)) s.ws.close();
        });
    });
});

// ---------------------------------------------------------------------------
describe('event catalog', () => {
    describe('jobs', () => {
        let cli: CliServerResult;
        let jobs: CliJobsPluginResult;
        let r: ReturnType<typeof record>;
        let release: (() => void) | undefined;
        let fail = false;

        const quick: ICliJob = {
            executeAsync: async () => {
                if (fail) throw new Error('job failed');
            },
        };
        const slow: ICliJob = {
            executeAsync: (_ctx, signal) =>
                new Promise<void>((resolve) => {
                    release = resolve;
                    signal.addEventListener('abort', () => resolve());
                }),
        };

        beforeAll(() => {
            cli = createCliServer({ mcp: true });
            jobs = new CliJobsBuilder()
                .addJob(quick, { id: 'quick', name: 'quick', interval: '1h', maxRetries: 1, retryDelay: '1s', retryStrategy: 'fixed' })
                .addJob(slow, { id: 'slow', name: 'slow', interval: '1h' })
                .addJob(slow, { id: 'bounded', name: 'bounded', interval: '1h', timeout: '1s' })
                .build();
            cli.mountPlugin(jobs);
            r = record(cli.eventBus, 'job:*');
        });
        afterEach(() => r.clear());
        afterAll(() => jobs.scheduler.stop());

        it('trigger: job:started, job:completed (scheduler) and job:triggered (API)', async () => {
            await request(cli.app).post(`${V1}/jobs/quick/trigger`).expect(200);
            expect(r.events.map((e) => e.type)).toEqual(['job:started', 'job:completed', 'job:triggered']);
            const [started, completed, triggered] = r.events;
            expect(started.data).toEqual({ jobId: 'quick', executionId: expect.any(String) });
            expect(started.audience).toEqual({ permission: 'jobs:read' });
            expect(completed.data).toEqual({ jobId: 'quick', executionId: started.data.executionId, duration: expect.any(Number) });
            expect(triggered.data).toEqual({ jobId: 'quick' });
            expect(triggered.audience).toEqual({ permission: 'jobs:read' });
        });

        it('a failing run: job:failed then job:retrying', async () => {
            fail = true;
            try {
                await request(cli.app).post(`${V1}/jobs/quick/trigger`).expect(200);
            } finally {
                fail = false;
            }
            expect(r.of('job:failed')[0].data).toEqual({ jobId: 'quick', executionId: expect.any(String), error: 'job failed' });
            expect(r.of('job:retrying')[0].data).toEqual({ jobId: 'quick', executionId: expect.any(String), attempt: 1, maxRetries: 1, delayMs: 1000 });
            expect(r.of('job:failed')).toHaveLength(2);
        });

        it('cancel: job:cancelled; timeout: job:timed_out', async () => {
            const run = request(cli.app).post(`${V1}/jobs/slow/trigger`).then((res) => res);
            await waitFor(() => r.of('job:started').length === 1);
            await request(cli.app).post(`${V1}/jobs/slow/cancel`).expect(200);
            expect((await run).status).toBe(200);
            expect(r.of('job:cancelled')[0].data).toEqual({ jobId: 'slow', executionId: expect.any(String) });

            await request(cli.app).post(`${V1}/jobs/bounded/trigger`).expect(200);
            expect(r.of('job:timed_out')[0].data).toMatchObject({ jobId: 'bounded', executionId: expect.any(String) });
        });

        it('pause, resume, stop carry the status', async () => {
            await request(cli.app).post(`${V1}/jobs/quick/pause`).expect(200);
            await request(cli.app).post(`${V1}/jobs/quick/resume`).expect(200);
            await request(cli.app).post(`${V1}/jobs/quick/stop`).expect(200);
            expect(r.events.map((e) => [e.type, e.data])).toEqual([
                ['job:paused', { jobId: 'quick', status: 'paused' }],
                ['job:resumed', { jobId: 'quick', status: 'active' }],
                ['job:stopped', { jobId: 'quick', status: 'stopped' }],
            ]);
            await request(cli.app).post(`${V1}/jobs/quick/resume`).expect(409);
        });

        it('options change: job:updated', async () => {
            await request(cli.app).put(`${V1}/jobs/quick`).send({ description: 'changed' }).expect(200);
            expect(r.events.map((e) => [e.type, e.data])).toEqual([['job:updated', { jobId: 'quick' }]]);
        });

        it('deleting runs: job:runs-deleted with executionId (one) or count (bulk)', async () => {
            const history = await request(cli.app).get(`${V1}/jobs/quick/history`).expect(200);
            const [first, ...rest] = history.body.items as Array<{ id: string }>;
            await request(cli.app).delete(`${V1}/jobs/quick/history/${first.id}`).expect(200);
            await request(cli.app).delete(`${V1}/jobs/quick/history`).expect(200);
            expect(r.events.map((e) => [e.type, e.data])).toEqual([
                ['job:runs-deleted', { jobId: 'quick', executionId: first.id }],
                ['job:runs-deleted', { jobId: 'quick', count: rest.length }],
            ]);
        });

        it('MCP: jobs_trigger publishes job:triggered, jobs_delete_runs job:runs-deleted', async () => {
            await request(cli.app).post(`${V1}/jobs/quick/resume`).send();
            await callTool(cli.app, 'jobs_trigger', { id: 'quick' });
            expect(r.of('job:triggered').map((e) => e.data)).toEqual([{ jobId: 'quick' }]);
            await callTool(cli.app, 'jobs_delete_runs', { id: 'quick' });
            expect(r.of('job:runs-deleted')[0].data).toEqual({ jobId: 'quick', count: expect.any(Number) });
        });

        it('a plugin built with its own broadcast function keeps it', async () => {
            const broadcast = vi.fn();
            const own = new CliJobsBuilder().addJob(quick, { id: 'own', name: 'own', interval: '1h' }).build(broadcast);
            const server = createCliServer({});
            server.mountPlugin(own);
            await own.scheduler.pauseAsync('own');
            expect(broadcast).toHaveBeenCalledWith({ type: 'job:paused', timestamp: expect.stringMatching(ISO), jobId: 'own', status: 'paused' });
            await own.scheduler.stop();
        });
    });

    describe('users plugin', () => {
        let cli: CliServerResult;
        let users: UsersPluginResult;
        let r: ReturnType<typeof record>;
        let root: { token: string; userId: string; sessionId: string };

        const login = async (username: string, password: string) => {
            const res = await request(cli.app).post(`${V1}/sessions`).send({ username, password }).expect(201);
            return { token: res.body.token as string, userId: res.body.session.user.id as string, sessionId: res.body.session.id as string };
        };
        const eventsOf = (prefix: string) => r.events.filter((e) => e.type.startsWith(prefix)).map((e) => ({ type: e.type, data: e.data, audience: e.audience }));

        beforeAll(async () => {
            cli = createCliServer({});
            users = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build();
            await users.ready;
            cli.mountPlugin(users);
            r = record(cli.eventBus);
            root = await login('root', ROOT_PASS);
            r.clear();
        });
        afterEach(() => r.clear());
        afterAll(() => users.dispose());

        it('sessions: session:opened on sign-in, session:closed on sign-out and revoke', async () => {
            const a = await login('root', ROOT_PASS);
            await request(cli.app).delete(`${V1}/sessions/current`).set(bearer(a.token)).expect((res) => expect(res.status).toBeLessThan(300));
            const b = await login('root', ROOT_PASS);
            await request(cli.app).delete(`${V1}/sessions/${b.sessionId}`).set(bearer(root.token)).expect(204);
            const audience = { permission: 'sessions:read' };
            expect(eventsOf('session:')).toEqual([
                { type: 'session:opened', data: { userId: root.userId, username: 'root', sessionId: a.sessionId }, audience },
                { type: 'session:closed', data: { userId: root.userId, username: 'root', sessionId: a.sessionId }, audience },
                { type: 'session:opened', data: { userId: root.userId, username: 'root', sessionId: b.sessionId }, audience },
                { type: 'session:closed', data: { userId: root.userId, username: 'root', sessionId: b.sessionId }, audience },
            ]);
        });

        it('users: created, updated (profile, password, membership, disabled), deleted', async () => {
            const created = await request(cli.app).post(`${V1}/users`).set(bearer(root.token)).send({ name: 'ann', email: 'ann@x.io', password: 'annpass' }).expect(201);
            const id = created.body.id;
            await request(cli.app).put(`${V1}/users/${id}`).set(bearer(root.token)).send({ email: 'ann2@x.io' }).expect(200);
            await request(cli.app).put(`${V1}/users/${id}/password`).set(bearer(root.token)).send({ password: 'newpass' }).expect(204);
            await request(cli.app).post(`${V1}/groups/admin/members/${id}`).set(bearer(root.token)).expect((res) => expect(res.status).toBeLessThan(300));
            await request(cli.app).put(`${V1}/users/${id}`).set(bearer(root.token)).send({ disabled: true }).expect(200);
            await request(cli.app).delete(`${V1}/users/${id}`).set(bearer(root.token)).expect(204);
            const data = { userId: id, username: 'ann', actor: 'root' };
            const audience = { permission: 'users:read' };
            expect(eventsOf('user:')).toEqual([
                { type: 'user:created', data, audience },
                { type: 'user:updated', data, audience },
                { type: 'user:updated', data, audience },
                { type: 'user:updated', data, audience },
                { type: 'user:updated', data, audience },
                { type: 'user:deleted', data, audience },
            ]);
        });

        it('groups: created, updated, deleted', async () => {
            await request(cli.app).post(`${V1}/groups`).set(bearer(root.token)).send({ name: 'ops', permissions: ['jobs:read'] }).expect(201);
            await request(cli.app).put(`${V1}/groups/ops`).set(bearer(root.token)).send({ description: 'Operations' }).expect(200);
            await request(cli.app).delete(`${V1}/groups/ops`).set(bearer(root.token)).expect(204);
            const audience = { permission: 'groups:read' };
            expect(eventsOf('group:')).toEqual([
                { type: 'group:created', data: { group: 'ops', actor: 'root' }, audience },
                { type: 'group:updated', data: { group: 'ops', actor: 'root' }, audience },
                { type: 'group:deleted', data: { group: 'ops', actor: 'root' }, audience },
            ]);
        });

        it('tokens: created and revoked, for tokens:read or the owner', async () => {
            const created = await request(cli.app).post(`${V1}/tokens`).set(bearer(root.token)).send({ name: 'ci', expiresInDays: 30 }).expect(201);
            const id = created.body.apiToken.id;
            await request(cli.app).delete(`${V1}/tokens/${id}`).set(bearer(root.token)).expect(204);
            const audience = { permission: 'tokens:read', userId: root.userId };
            expect(eventsOf('token:')).toEqual([
                { type: 'token:created', data: { tokenId: id, name: 'ci', userId: root.userId, actor: 'root' }, audience },
                { type: 'token:revoked', data: { tokenId: id, name: 'ci', userId: root.userId, actor: 'root' }, audience },
            ]);
        });

        it('audit: audit:recorded with the stored entry', async () => {
            await request(cli.app).post(`${V1}/groups`).set(bearer(root.token)).send({ name: 'auditors' }).expect(201);
            const recorded = r.of('audit:recorded');
            expect(recorded).toHaveLength(1);
            expect(recorded[0].audience).toEqual({ permission: 'audit:read' });
            expect(recorded[0].timestamp).toMatch(ISO);
            expect(recorded[0].data).toMatchObject({ id: expect.any(String), event: 'group_created', username: 'root', details: 'auditors' });
            const entries = await request(cli.app).get(`${V1}/audit?event=group_created`).set(bearer(root.token)).expect(200);
            expect(entries.body[0].id).toBe(recorded[0].data.id);
            expect(new Date(entries.body[0].timestamp).toISOString()).toBe(recorded[0].timestamp);
        });
    });

    it('audit plugin on its own: a host entry publishes audit:recorded once mounted', async () => {
        const cli = createCliServer({});
        const audit = new CliAuditBuilder().build();
        cli.mountPlugin(audit);
        const r = record(cli.eventBus, 'audit:*');
        await audit.store.log({ timestamp: Date.now(), event: 'plan_changed', username: 'host', target: 'plan:pro' });
        expect(r.events).toHaveLength(1);
        expect(r.events[0].data).toMatchObject({ event: 'plan_changed', username: 'host', target: 'plan:pro', id: expect.any(String) });
        expect((await audit.store.getEntries())[0].id).toBe(r.events[0].data.id);
    });

    describe('files', () => {
        it('the filesystem API and the MCP fs tools publish fs:changed', async () => {
            const cli = createCliServer({ mcp: true, configure: (b) => b.setFileStorageProvider(new InMemoryFileStorageProvider()) });
            const r = record(cli.eventBus, 'fs:*');
            await request(cli.app).post('/api/qcli/fs/mkdir').send({ path: '/docs' }).expect((res) => expect(res.status).toBeLessThan(300));
            await request(cli.app).post('/api/qcli/fs/upload').field('path', '/docs/a.txt').attach('file', Buffer.from('hi'), 'a.txt').expect((res) => expect(res.status).toBeLessThan(300));
            await callTool(cli.app, 'fs_write', { path: '/docs/b.txt', content: 'b' });
            await callTool(cli.app, 'fs_mkdir', { path: '/more' });
            await request(cli.app).delete('/api/qcli/fs/rm').query({ path: '/docs/a.txt' }).expect((res) => expect(res.status).toBeLessThan(300));
            await callTool(cli.app, 'fs_delete', { path: '/docs/b.txt' });
            expect(r.events.map((e) => e.data)).toEqual([
                { action: 'mkdir', path: '/docs' },
                { action: 'upload', path: '/docs/a.txt' },
                { action: 'write', path: '/docs/b.txt' },
                { action: 'mkdir', path: '/more' },
                { action: 'delete', path: '/docs/a.txt' },
                { action: 'delete', path: '/docs/b.txt' },
            ]);
            expect(r.events.every((e) => e.type === 'fs:changed' && e.audience.permission === 'files:read')).toBe(true);
        });

        it('move and copy carry newPath; failed writes publish nothing', async () => {
            const bus = new CliEventBus();
            const r = record(bus);
            const provider = withFileStorageEvents(new InMemoryFileStorageProvider(), bus);
            await provider.writeFile('/a.txt', 'a');
            await provider.copy('/a.txt', '/b.txt');
            await provider.move('/b.txt', '/c.txt');
            await expect(provider.remove('/missing.txt')).rejects.toThrow();
            expect(await provider.readFile('/c.txt')).toBe('a');
            expect(r.events.map((e) => e.data)).toEqual([
                { action: 'write', path: '/a.txt' },
                { action: 'copy', path: '/a.txt', newPath: '/b.txt' },
                { action: 'move', path: '/b.txt', newPath: '/c.txt' },
            ]);
        });
    });

    describe('commands', () => {
        it('execute, stream and MCP publish command:executed with the processor name only', async () => {
            const cli = createCliServer({
                mcp: true,
                configure: (b) => {
                    b.addProcessor(proc('echo', { handleAsync: async (c) => `${c.value ?? ''}` }));
                    b.addProcessor(proc('broken', { handleStructuredAsync: async () => ({ exitCode: 1, outputs: [] }) }));
                },
            });
            const r = record(cli.eventBus, 'command:*');
            await request(cli.app).post(`${V1}/execute`).send({ command: 'echo', value: 'secret-arg', args: { x: 'secret' } }).expect(200);
            await request(cli.app).post(`${V1}/execute/stream`).send({ command: 'broken' }).expect(200);
            await callTool(cli.app, 'echo', {});
            await request(cli.app).post(`${V1}/execute`).send({ command: 'nope' }).expect(200);
            expect(r.events.map((e) => e.data)).toEqual([
                { command: 'echo', success: true, durationMs: expect.any(Number) },
                { command: 'broken', success: false, durationMs: expect.any(Number) },
                { command: 'echo', success: true, durationMs: expect.any(Number) },
            ]);
            expect(r.events.every((e) => e.audience.permission === 'audit:read')).toBe(true);
            expect(JSON.stringify(r.events)).not.toContain('secret');
        });

        it('carries the caller userId on a protected server', async () => {
            const cli = createCliServer({ configure: (b) => b.addProcessor(proc('echo')) });
            const users = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).build();
            await users.ready;
            cli.mountPlugin(users);
            const r = record(cli.eventBus, 'command:*');
            const login = await request(cli.app).post(`${V1}/sessions`).send({ username: 'root', password: ROOT_PASS }).expect(201);
            await request(cli.app).post(`${V1}/execute`).set(bearer(login.body.token)).send({ command: 'echo' }).expect(200);
            expect(r.events[0].data).toEqual({ command: 'echo', success: true, durationMs: expect.any(Number), userId: login.body.session.user.id });
            users.dispose();
        });
    });
});
