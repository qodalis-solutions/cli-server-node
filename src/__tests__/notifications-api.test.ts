/**
 * System notifications end to end: the API (`/api/v1/qcli/notifications`), permissions filtering and per-user read
 * state on a protected server, `notification:changed` on the events socket (with each socket's own unread count), the
 * `notifications` command, the `notifications_list` MCP tool, persistence across a restart and the server's own
 * sources (security warning, restart required, plugins that failed or need configuration).
 */
import { mkdtempSync, rmSync } from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CliNotificationKeys, type CliPluginEntry } from '@qodalis/cli-server-abstractions';
import { createCliServer, type CliServerOptions, type CliServerResult } from '../create-cli-server';
import { protect, runCommand } from './command-test-helpers';

const V1 = '/api/v1/qcli';
const NOTIF = `${V1}/notifications`;
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'qcli-notif-api-'));
    dirs.push(d);
    return d;
};

function server(options: CliServerOptions = {}): CliServerResult {
    const cli = createCliServer({ dataDir: temp(), ...options });
    cleanups.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return cli;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const note = (key: string, extra: Record<string, unknown> = {}) => ({ key, kind: 'test', severity: 'info' as const, title: `About ${key}`, message: 'Details', ...extra });

describe('notifications API on an open server', () => {
    it('lists, reads, reads all, dismisses and clears', async () => {
        const cli = server();
        const a = cli.notifications.notify(note('a'));
        cli.notifications.notify(note('b', { severity: 'error', link: '/plugins' }));

        let res = await request(cli.app).get(NOTIF).expect(200);
        expect(res.body.unreadCount).toBe(2);
        expect(res.body.items.map((n: { key: string }) => n.key).sort()).toEqual(['a', 'b']);
        expect((await request(cli.app).get(`${NOTIF}?severity=error`).expect(200)).body.items.map((n: { key: string }) => n.key)).toEqual(['b']);

        res = await request(cli.app).post(`${NOTIF}/${a.id}/read`).expect(200);
        expect(res.body).toMatchObject({ item: { id: a.id, read: true }, unreadCount: 1 });
        expect((await request(cli.app).get(`${NOTIF}?unread=true`).expect(200)).body.items.map((n: { key: string }) => n.key)).toEqual(['b']);

        expect((await request(cli.app).post(`${NOTIF}/read-all`).expect(200)).body).toEqual({ marked: 1, unreadCount: 0 });

        expect((await request(cli.app).delete(`${NOTIF}/${a.id}`).expect(200)).body).toMatchObject({ dismissed: true });
        const b = cli.notifications.get('b')!;
        expect((await request(cli.app).delete(`${NOTIF}/${b.id}?scope=all`).expect(200)).body).toMatchObject({ cleared: true });
        expect((await request(cli.app).get(NOTIF).expect(200)).body).toEqual({ items: [], unreadCount: 0 });
        expect(cli.notifications.get('b')).toBeUndefined();
    });

    it('answers 404 for an unknown id and 400 for a bad filter', async () => {
        const cli = server();
        await request(cli.app).post(`${NOTIF}/n_nope/read`).expect(404);
        await request(cli.app).delete(`${NOTIF}/n_nope`).expect(404);
        await request(cli.app).get(`${NOTIF}?severity=fatal`).expect(400);
        await request(cli.app).get(`${NOTIF}?limit=0`).expect(400);
        expect((await request(cli.app).get(`${NOTIF}?limit=1`).expect(200)).body.items).toEqual([]);
    });

    it('persists across a restart (same data directory)', async () => {
        const dataDir = temp();
        const first = server({ dataDir });
        const n = first.notifications.notify(note('kept'));
        await request(first.app).post(`${NOTIF}/${n.id}/read`).expect(200);
        const second = server({ dataDir });
        expect((await request(second.app).get(NOTIF).expect(200)).body).toMatchObject({ unreadCount: 0, items: [{ id: n.id, key: 'kept', read: true }] });
    });

    it('memory only with notifications.file false', async () => {
        const dataDir = temp();
        server({ dataDir, notifications: { file: false } }).notifications.notify(note('gone'));
        expect((await request(server({ dataDir }).app).get(NOTIF).expect(200)).body.items).toEqual([]);
    });
});

describe('notifications API on a protected server', () => {
    it('filters by permission, keeps the read state per user, and clearing for everyone needs notifications:manage', async () => {
        const cli = server();
        const { plugin, tokens } = await protect(cli, { admin: ['admin:access'], plain: ['commands:execute'], manager: ['notifications:manage'] });
        cleanups.push(() => plugin.dispose());
        const adminOnly = cli.notifications.notify(note('admin-only', { requiredPermission: 'admin:access' }));
        const everyone = cli.notifications.notify(note('everyone'));

        await request(cli.app).get(NOTIF).expect(401);
        const keys = async (who: string) => (await request(cli.app).get(NOTIF).set(bearer(tokens[who])).expect(200)).body.items.map((n: { key: string }) => n.key).sort();
        expect(await keys('admin')).toEqual(['admin-only', 'everyone']);
        expect(await keys('plain')).toEqual(['everyone']);
        expect(await keys('root')).toEqual(['admin-only', 'everyone']);

        // a hidden one is not found
        await request(cli.app).post(`${NOTIF}/${adminOnly.id}/read`).set(bearer(tokens.plain)).expect(404);

        await request(cli.app).post(`${NOTIF}/${everyone.id}/read`).set(bearer(tokens.admin)).expect(200);
        expect((await request(cli.app).get(NOTIF).set(bearer(tokens.admin))).body.unreadCount).toBe(1);
        expect((await request(cli.app).get(NOTIF).set(bearer(tokens.plain))).body.unreadCount).toBe(1);

        // dismiss: for the caller only
        await request(cli.app).delete(`${NOTIF}/${everyone.id}`).set(bearer(tokens.plain)).expect(200);
        expect(await keys('plain')).toEqual([]);
        expect(await keys('admin')).toEqual(['admin-only', 'everyone']);

        // for everyone: notifications:manage
        const refused = await request(cli.app).delete(`${NOTIF}/${everyone.id}?scope=all`).set(bearer(tokens.admin)).expect(403);
        expect(refused.body.error).toContain('notifications:manage');
        await request(cli.app).delete(`${NOTIF}/${everyone.id}?scope=all`).set(bearer(tokens.manager)).expect(200);
        expect(await keys('admin')).toEqual(['admin-only']);
    });

    it('lists the new permissions in the catalog', async () => {
        const cli = server();
        expect(cli.builder.permissions.find('notifications:manage')).toMatchObject({ group: 'Server', surface: 'cli' });
        expect(cli.builder.permissions.find('updates:read')).toMatchObject({ group: 'Server', surface: 'cli' });
    });
});

// ------------------------------------------------------------------ events socket

interface Socket {
    ws: WebSocket;
    messages: any[];
    next(type: string, match?: (m: any) => boolean): Promise<any>;
}

function connect(port: number, path: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const messages: any[] = [];
        const waiters: Array<{ type: string; match: (m: any) => boolean; resolve: (m: any) => void }> = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            messages.push(message);
            for (const w of waiters.filter((w) => w.type === message.type && w.match(message))) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(message);
            }
        });
        const next = (type: string, match: (m: any) => boolean = () => true) =>
            new Promise<any>((res, rej) => {
                const found = messages.find((m) => m.type === type && match(m));
                if (found) return res(found);
                const timer = setTimeout(() => rej(new Error(`no ${type} within 3 s; got ${messages.map((m) => m.type).join(', ')}`)), 3000);
                waiters.push({ type, match, resolve: (m) => (clearTimeout(timer), res(m)) });
            });
        ws.on('open', () => resolve({ ws, messages, next }));
        ws.on('error', reject);
    });
}

async function listen(cli: CliServerResult): Promise<number> {
    const httpServer = http.createServer(cli.app);
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(httpServer);
    cleanups.push(async () => {
        httpServer.closeAllConnections?.();
        await new Promise<void>((r) => httpServer.close(() => r()));
    });
    return (httpServer.address() as AddressInfo).port;
}

describe('notification:changed on the events socket', () => {
    it('open server: carries the action, the item and the unread count', async () => {
        const cli = server();
        const socket = await connect(await listen(cli), '/ws/v1/qcli/events');
        cleanups.push(() => socket.ws.close());
        const n = cli.notifications.notify(note('ws', { severity: 'warning' }));
        expect(await socket.next('notification:changed')).toMatchObject({
            action: 'created',
            id: n.id,
            key: 'ws',
            unreadCount: 1,
            item: { id: n.id, title: 'About ws', severity: 'warning', read: false },
        });
        await request(cli.app).post(`${NOTIF}/${n.id}/read`).expect(200);
        expect(await socket.next('notification:changed', (m) => m.action === 'read')).toMatchObject({ unreadCount: 0, item: { read: true } });
        cli.notifications.resolve('ws');
        expect(await socket.next('notification:changed', (m) => m.action === 'resolved')).toMatchObject({ key: 'ws', unreadCount: 0 });
    });

    it('protected server: each socket gets its own unread count; a user without the permission gets nothing', async () => {
        const cli = server();
        const { plugin, tokens } = await protect(cli, { admin: ['admin:access'], plain: ['commands:execute'] });
        cleanups.push(() => plugin.dispose());
        const port = await listen(cli);
        const ticket = async (token: string) => (await request(cli.app).post(`${V1}/sessions/ws-ticket`).set(bearer(token)).expect(201)).body.ticket;
        const admin = await connect(port, `/ws/v1/qcli/events?ticket=${await ticket(tokens.admin)}`);
        const plain = await connect(port, `/ws/v1/qcli/events?ticket=${await ticket(tokens.plain)}`);
        cleanups.push(() => admin.ws.close(), () => plain.ws.close());

        cli.notifications.notify(note('public'));
        expect(await admin.next('notification:changed', (m) => m.key === 'public')).toMatchObject({ unreadCount: 1 });
        expect(await plain.next('notification:changed', (m) => m.key === 'public')).toMatchObject({ unreadCount: 1 });

        cli.notifications.notify(note('secret', { requiredPermission: 'admin:access' }));
        expect(await admin.next('notification:changed', (m) => m.key === 'secret')).toMatchObject({ action: 'created', unreadCount: 2 });

        // the admin reads everything: only the admin's sockets hear of it
        await request(cli.app).post(`${NOTIF}/read-all`).set(bearer(tokens.admin)).expect(200);
        expect(await admin.next('notification:changed', (m) => m.action === 'read-all')).toMatchObject({ unreadCount: 0 });
        await new Promise((r) => setTimeout(r, 100));
        expect(plain.messages.filter((m) => m.type === 'notification:changed').map((m) => m.key)).toEqual(['public']);
    });
});

// ------------------------------------------------------------------ command and MCP

describe('notifications command', () => {
    it('lists, reads and clears', async () => {
        const cli = server();
        const n = cli.notifications.notify(note('cmd', { severity: 'error', title: 'Something broke' }));
        let out = (await runCommand(cli, 'notifications list')).text;
        expect(out).toContain('1 notification(s), 1 unread');
        expect(out).toContain('Something broke');
        expect(out).toContain(n.id);
        expect((await runCommand(cli, 'notifications')).text).toContain('Something broke');

        expect((await runCommand(cli, `notifications read ${n.id.slice(0, 6)}`)).text).toBe('Read: Something broke');
        expect((await runCommand(cli, 'notifications list --unread')).text).toBe('No unread notifications.');
        expect((await runCommand(cli, 'notifications read --all')).text).toBe('Marked 0 notification(s) read.');
        expect((await runCommand(cli, 'notifications read n_missing')).text).toBe('Error: notification not found: n_missing');

        expect((await runCommand(cli, `notifications clear ${n.id}`)).text).toBe('Dismissed: Something broke');
        expect((await runCommand(cli, 'notifications list')).text).toBe('No notifications.');
    });

    it('clear --all needs notifications:manage on a protected server', async () => {
        const cli = server();
        const { plugin, tokens } = await protect(cli, { plain: ['commands:execute'], manager: ['commands:execute', 'notifications:manage'] });
        cleanups.push(() => plugin.dispose());
        const n = cli.notifications.notify(note('shared'));
        expect((await runCommand(cli, `notifications clear ${n.id} --all`, tokens.plain)).text).toBe('Error: forbidden: missing permission notifications:manage');
        expect((await runCommand(cli, `notifications clear ${n.id} --all`, tokens.manager)).text).toBe('Cleared for everyone: About shared');
        expect(cli.notifications.get('shared')).toBeUndefined();
    });
});

describe('notifications_list MCP tool', () => {
    it("lists the caller's notifications", async () => {
        const cli = server({ mcp: true });
        cli.notifications.notify(note('mcp', { title: 'From MCP' }));
        const res = await request(cli.app)
            .post('/api/qcli/mcp')
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json, text/event-stream')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notifications_list', arguments: { unread: true } } });
        expect(res.status).toBe(200);
        expect(res.body.result.isError).toBe(false);
        expect(res.body.result.structuredContent).toMatchObject({ unreadCount: 1, items: [{ key: 'mcp', title: 'From MCP' }] });
    });
});

// ------------------------------------------------------------------ the server's own sources

describe("the server's own notifications", () => {
    it('warns while allowAnonymousAdmin is on and resolves it once off', async () => {
        const dataDir = temp();
        const open = server({ dataDir, allowAnonymousAdmin: true });
        expect(open.notifications.get(CliNotificationKeys.AnonymousAdmin)).toMatchObject({ kind: 'security', severity: 'warning', requiredPermission: 'admin:access' });
        const closed = server({ dataDir });
        expect(closed.notifications.get(CliNotificationKeys.AnonymousAdmin)).toBeUndefined();
    });

    it('says when a restart is required and resolves it when nothing waits any more', async () => {
        const cli = server();
        // the restart-required event is delivered on the next turns of the event loop
        const settle = () => new Promise((r) => setImmediate(r));
        cli.restart.markRequired({ id: 'config:cors.cors.mode', source: 'config', description: 'CORS: Mode changed' });
        await settle();
        expect(cli.notifications.get(CliNotificationKeys.RestartRequired)).toMatchObject({
            kind: 'restart',
            severity: 'warning',
            message: 'CORS: Mode changed',
            data: { pending: ['config:cors.cors.mode'] },
        });
        cli.restart.markRequired({ id: 'x', source: 'test', description: 'Another' });
        await settle();
        expect(cli.notifications.get(CliNotificationKeys.RestartRequired)?.title).toContain('2 changes');
        cli.restart.clearRequired('config:cors.cors.mode');
        cli.restart.clearRequired('x');
        await settle();
        expect(cli.notifications.get(CliNotificationKeys.RestartRequired)).toBeUndefined();
    });

    it('a restarted server (nothing pending) resolves the restart notification it kept', async () => {
        const dataDir = temp();
        const first = server({ dataDir });
        first.restart.markRequired({ id: 'x', source: 'test', description: 'Pending' });
        await new Promise((r) => setImmediate(r));
        expect(first.notifications.get(CliNotificationKeys.RestartRequired)).toBeDefined();
        expect(server({ dataDir }).notifications.get(CliNotificationKeys.RestartRequired)).toBeUndefined();
    });

    it('reports plugins that failed to load or need configuration, and resolves them once they load', async () => {
        const dataDir = temp();
        const broken: CliPluginEntry = {
            plugin: { id: 'broken', package: '@acme/broken', version: '1.0.0' },
            createPlugin: () => {
                throw new Error('cannot connect');
            },
        };
        const unconfigured: CliPluginEntry = {
            plugin: { id: 'needy', package: '@acme/needy', version: '2.0.0' },
            createPlugin: (context) => context.needsConfiguration(['settings.apiKey']),
        };
        const first = server({ dataDir, configure: (b) => b.addPlugin(broken).addPlugin(unconfigured) });
        await first.serverPlugins.ready();
        await new Promise((r) => setImmediate(r));
        expect(first.notifications.get('plugin.failed:broken')).toMatchObject({
            kind: 'plugin',
            severity: 'error',
            title: 'Plugin broken failed to load',
            message: '@acme/broken@1.0.0: cannot connect',
            link: '/plugins/%40acme%2Fbroken',
        });
        expect(first.notifications.get('plugin.needs-configuration:needy')).toMatchObject({
            severity: 'warning',
            message: 'Set settings.apiKey, then restart the server.',
            data: { missing: ['settings.apiKey'] },
        });

        // next start: both load
        const fixed: CliPluginEntry = { plugin: broken.plugin, createPlugin: () => undefined };
        const configured: CliPluginEntry = { plugin: unconfigured.plugin, createPlugin: () => undefined };
        const second = server({ dataDir, configure: (b) => b.addPlugin(fixed).addPlugin(configured) });
        await second.serverPlugins.ready();
        await new Promise((r) => setImmediate(r));
        expect(second.notifications.get('plugin.failed:broken')).toBeUndefined();
        expect(second.notifications.get('plugin.needs-configuration:needy')).toBeUndefined();
    });

    it("plugins publish through their context and the builder", async () => {
        const entry: CliPluginEntry = {
            plugin: { id: 'talker', package: '@acme/talker', version: '1.0.0' },
            createPlugin: (context) => {
                context.notifications!.notify({ key: 'talker:hello', kind: 'talker', severity: 'info', title: 'Hello from a plugin', message: '' });
                return undefined;
            },
        };
        const cli = server({ configure: (b) => b.addPlugin(entry) });
        cli.builder.notifications.notify(note('from-builder'));
        await cli.serverPlugins.ready();
        expect(cli.notifications.get('talker:hello')).toMatchObject({ title: 'Hello from a plugin' });
        expect(cli.notifications.get('from-builder')).toBeDefined();
    });
});
