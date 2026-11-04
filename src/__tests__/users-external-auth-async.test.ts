/**
 * Async external auth adapters (mirrors qodalis-solutions/cli-server-dotnet#26):
 * `setAuthAdapter` accepts sync and async functions; the plugin awaits the
 * result for requests, protected server routes and ticket issuance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCliServer } from '../create-cli-server';
import { AuthAdapter, CliUsersBuilder, ExternalAuthResult, UsersPluginResult, User } from '../../plugins/users/index';

const V1 = '/api/v1/qcli';
const ORIGIN = 'http://localhost:4300';

const user = (id: string, extra: Partial<User> = {}): User => ({
    id,
    name: id,
    email: `${id}@host.io`,
    groups: [],
    createdAt: 0,
    updatedAt: 0,
    ...extra,
});

/** What the host's "database" says about each user (changes during a test). */
let db: Map<string, { user: User; isAdmin?: boolean }>;

const lookup = (req: express.Request): ExternalAuthResult | null => {
    const id = req.headers['x-host-user'];
    return typeof id === 'string' ? db.get(id) ?? null : null;
};

/** Resolves after a tick, as a database call would. */
const asyncAdapter: AuthAdapter = async (req) => {
    await new Promise((r) => setTimeout(r, 5));
    return lookup(req);
};

const plugins: UsersPluginResult[] = [];

function build(adapter: AuthAdapter): { app: express.Express; plugin: UsersPluginResult } {
    const plugin = new CliUsersBuilder().setAuthAdapter(adapter).setAllowedOrigins([ORIGIN]).build();
    plugins.push(plugin);
    const app = express();
    app.use(plugin.prefix, plugin.router);
    return { app, plugin };
}

afterEach(() => {
    for (const p of plugins.splice(0)) p.dispose();
});

describe('async external auth adapter', () => {
    it('authenticates requests (isAdmin maps to the admin group)', async () => {
        db = new Map([['alice', { user: user('alice'), isAdmin: true }]]);
        const { app, plugin } = build(asyncAdapter);
        await plugin.ready;

        const res = await request(app).get(`${V1}/sessions/current`).set('X-Host-User', 'alice');
        expect(res.status).toBe(200);
        expect(res.body.user).toMatchObject({ id: 'alice', groups: ['admin'] });
        expect(res.body.permissions).toEqual(['*']);
    });

    it('answers 401 when the async adapter resolves null or undefined', async () => {
        db = new Map();
        for (const adapter of [asyncAdapter, (async () => undefined) as AuthAdapter]) {
            const { app } = build(adapter);
            const res = await request(app).get(`${V1}/sessions/current`).set('X-Host-User', 'nobody');
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ error: 'unauthorized' });
        }
    });

    it('refuses a user the async adapter returns disabled (401 account disabled)', async () => {
        db = new Map([['bob', { user: user('bob', { disabled: true }) }]]);
        const { app } = build(asyncAdapter);
        const res = await request(app).get(`${V1}/sessions/current`).set('X-Host-User', 'bob');
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'account disabled' });
    });

    it('answers 500 without the adapter error message when the async adapter rejects', async () => {
        const { app } = build(async () => {
            throw new Error('database down');
        });
        const res = await request(app).get(`${V1}/sessions/current`).set('X-Host-User', 'alice');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internal server error' });
    });

    it('sync and async forms of the same adapter give the same session', async () => {
        db = new Map([['carol', { user: user('carol', { groups: ['users'] }) }]]);
        const bodies = [];
        for (const adapter of [lookup as AuthAdapter, asyncAdapter]) {
            const { app, plugin } = build(adapter);
            await plugin.ready;
            const res = await request(app).get(`${V1}/sessions/current`).set('X-Host-User', 'carol');
            expect(res.status).toBe(200);
            bodies.push({ user: res.body.user, permissions: res.body.permissions });
        }
        expect(bodies[0]).toEqual(bodies[1]);
        expect(bodies[1].permissions).toEqual(['commands:execute']);
    });

    it('issues WebSocket tickets through the async adapter', async () => {
        db = new Map([['alice', { user: user('alice'), isAdmin: true }]]);
        const { app, plugin } = build(asyncAdapter);
        const res = await request(app).post(`${V1}/sessions/ws-ticket`).set('X-Host-User', 'alice').set('Origin', ORIGIN);
        expect(res.status).toBe(201);
        const ctx = await plugin.serverAuth.consumeTicket(res.body.ticket);
        expect(ctx).toMatchObject({ userId: 'alice', permissions: ['*'] });
    });

    it('protects server routes through the async adapter', async () => {
        db = new Map([['alice', { user: user('alice'), isAdmin: true }]]);
        const cli = createCliServer({ allowedOrigins: [ORIGIN] });
        const plugin = new CliUsersBuilder().setAuthAdapter(asyncAdapter).build((m) => cli.eventSocketManager.broadcastMessage(m));
        plugins.push(plugin);
        cli.mountPlugin(plugin);
        await plugin.ready;

        expect((await request(cli.app).get(`${V1}/commands`)).status).toBe(401);
        expect((await request(cli.app).get(`${V1}/commands`).set('X-Host-User', 'alice')).status).toBe(200);
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
});
