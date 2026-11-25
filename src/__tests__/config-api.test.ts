/**
 * The config API (admin plugin over the server's config providers): GET /config,
 * GET /config/{provider}, PATCH /config/{provider}/{section}: 200/400/401/403/404/409,
 * on an open server (static admin) and on a server protected by the users plugin
 * (config:read / config:write, a provider's requiredPermission, audit, config:changed).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { CliStoredConfigProvider, type CliEvent } from '@qodalis/cli-server-abstractions';

const V1 = '/api/v1/qcli';
const ROOT_PASS = 'rootpass1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

function billing(requiredPermission?: string) {
    return new CliStoredConfigProvider({
        id: requiredPermission ? 'vault' : 'billing',
        title: requiredPermission ? 'Vault' : 'Billing',
        requiredPermission,
        sections: [
            {
                id: 'invoices',
                settings: [
                    { key: 'dueDays', type: 'number', default: 30, validation: { min: 1, max: 90 } },
                    { key: 'apiKey', type: 'secret' },
                    { key: 'currency', type: 'enum', default: 'EUR', validation: { options: ['EUR', 'USD'] } },
                    { key: 'webhook', type: 'url', default: 'https://hooks.example/a' },
                    { key: 'region', type: 'string', mutable: false, default: 'eu' },
                ],
            },
        ],
    });
}

// ------------------------------------------------------------------ open server

describe('config API on an open server (static admin)', () => {
    let cli: CliServerResult;
    let admin: CliAdminPluginResult;
    let app: express.Express;
    let token: string;
    const events: CliEvent[] = [];

    beforeAll(async () => {
        cli = createCliServer({
            allowedOrigins: ['https://app.example'],
            mcp: true,
            configure: (b) => b.addConfigProvider(billing()),
        });
        admin = new CliAdminBuilder()
            .setCredentials('admin', 'adminpass')
            .setJwtSecret('jwt-secret-for-tests')
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
        admin.logBuffer.restoreConsole();
        cli.mountPlugin(new CliJobsBuilder().build());
        cli.mountPlugin(admin);
        cli.eventBus.subscribe('config:*', (e) => void events.push(e));
        app = cli.app;
        token = (await request(app).post(`${V1}/auth/login`).send({ username: 'admin', password: 'adminpass' })).body.token;
    });
    afterAll(() => admin.dispose());

    it('401 without the admin session', async () => {
        await request(app).get(`${V1}/config`).expect(401);
        await request(app).patch(`${V1}/config/custom/custom`).send({ changes: { a: 1 } }).expect(401);
    });

    it('GET /config: every provider, in order, with the JSON shape', async () => {
        const res = await request(app).get(`${V1}/config`).set(bearer(token)).expect(200);
        expect(res.headers['cache-control']).toBe('no-store');
        const ids = res.body.providers.map((p: any) => p.id);
        expect(ids).toEqual(['server', 'auth', 'host', 'cors', 'mcp', 'jobs', 'logs', 'billing', 'custom']);
        const billingView = res.body.providers.find((p: any) => p.id === 'billing');
        expect(Object.keys(res.body).sort()).toEqual(['providers', 'store']);
        expect(res.body.store).toEqual({ kind: 'memory', title: 'In memory', detail: '', persistent: false });
        expect(Object.keys(billingView).sort()).toEqual(['description', 'id', 'order', 'sections', 'storage', 'title', 'writable']);
        expect(billingView.storage).toEqual({ kind: 'store', description: 'Changes are saved to the config store', sources: [] });
        const storage = Object.fromEntries(res.body.providers.map((p: any) => [p.id, p.storage]));
        expect(storage.server).toEqual({ kind: 'runtime', description: 'Read from the running server process', sources: [] });
        expect(storage.host).toEqual({ kind: 'options', description: 'Server options and environment variables', sources: ['Server options', 'Environment variables'] });
        expect(storage.auth).toMatchObject({ kind: 'options', sources: [] });
        for (const id of ['cors', 'mcp', 'jobs', 'logs', 'custom']) expect(storage[id].kind).toBe('store');
        expect(billingView).toMatchObject({ title: 'Billing', description: '', order: 100, writable: true });
        const section = billingView.sections[0];
        expect(Object.keys(section).sort()).toEqual(['allowCustomKeys', 'description', 'entries', 'id', 'mutable', 'title', 'version']);
        expect(section).toMatchObject({ id: 'invoices', title: 'invoices', mutable: true, version: '0', allowCustomKeys: false });
        expect(section.entries[0]).toEqual({
            key: 'dueDays',
            label: 'dueDays',
            description: '',
            type: 'number',
            value: 30,
            default: 30,
            source: 'default',
            mutable: true,
            requiresRestart: false,
            sensitive: false,
            validation: { min: 1, max: 90 },
        });
        expect(section.entries[1]).toMatchObject({ key: 'apiKey', type: 'secret', value: null, default: null, sensitive: true, isSet: false });
    });

    it('GET /config/{provider}: one provider; 404 for an unknown one', async () => {
        const res = await request(app).get(`${V1}/config/server`).set(bearer(token)).expect(200);
        expect(res.body.id).toBe('server');
        expect(res.body.writable).toBe(false);
        expect(res.body.storage.kind).toBe('runtime');
        expect(res.body.store).toBeUndefined();
        expect(res.body.sections[0].entries.find((e: any) => e.key === 'platform').value).toBe('node');
        const missing = await request(app).get(`${V1}/config/nope`).set(bearer(token)).expect(404);
        expect(missing.body).toEqual({ error: 'unknown config provider: nope' });
    });

    it('PATCH: 200 with the section, applied keys, version; the change is visible', async () => {
        const res = await request(app)
            .patch(`${V1}/config/billing/invoices`)
            .set(bearer(token))
            .send({ changes: { dueDays: 45, currency: 'USD' }, version: '0' });
        expect(res.body).toMatchObject({ provider: 'billing' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ provider: 'billing', applied: ['dueDays', 'currency'], requiresRestart: false, version: '1' });
        expect(res.body.section.version).toBe('1');
        expect(res.body.section.entries.find((e: any) => e.key === 'dueDays')).toMatchObject({ value: 45, source: 'runtime' });
        const again = await request(app).get(`${V1}/config/billing`).set(bearer(token)).expect(200);
        expect(again.body.sections[0].entries.find((e: any) => e.key === 'currency').value).toBe('USD');
    });

    it('PATCH: 409 for a stale version, with the current one', async () => {
        const res = await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(token)).send({ changes: { dueDays: 50 }, version: '0' }).expect(409);
        expect(res.body).toEqual({ error: 'version conflict', version: '1' });
    });

    it('PATCH: 400 with per-key errors', async () => {
        const res = await request(app)
            .patch(`${V1}/config/billing/invoices`)
            .set(bearer(token))
            .send({ changes: { dueDays: 0, currency: 'GBP', webhook: 'not-a-url', region: 'us', unknown: 1 } })
            .expect(400);
        expect(res.body).toEqual({
            error: 'validation failed',
            errors: {
                dueDays: 'must be at least 1',
                currency: 'must be one of: EUR, USD',
                webhook: 'must be an absolute URL',
                region: 'read-only',
                unknown: 'unknown setting',
            },
        });
    });

    it('PATCH: 400 for bad bodies and read-only providers; 404 for unknown sections', async () => {
        expect((await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(token)).send({ dueDays: 3 }).expect(400)).body).toEqual({
            error: 'changes must be a non-empty object',
        });
        await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(token)).send([1]).expect(400);
        expect((await request(app).patch(`${V1}/config/server/runtime`).set(bearer(token)).send({ changes: { pid: 1 } }).expect(400)).body).toEqual({
            error: 'config provider server is read-only',
        });
        expect((await request(app).patch(`${V1}/config/billing/nope`).set(bearer(token)).send({ changes: { a: 1 } }).expect(404)).body).toEqual({
            error: 'unknown config section: billing.nope',
        });
        await request(app).patch(`${V1}/config/nope/x`).set(bearer(token)).send({ changes: { a: 1 } }).expect(404);
    });

    it('secrets: set and replaced, never returned; cleared with null', async () => {
        await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(token)).send({ changes: { apiKey: 'sk_live_top_secret' } }).expect(200);
        const res = await request(app).get(`${V1}/config`).set(bearer(token)).expect(200);
        expect(JSON.stringify(res.body)).not.toContain('sk_live_top_secret');
        const entry = res.body.providers.find((p: any) => p.id === 'billing').sections[0].entries.find((e: any) => e.key === 'apiKey');
        expect(entry).toMatchObject({ value: null, isSet: true });
        const patch = await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(token)).send({ changes: { apiKey: 'sk_live_other' } }).expect(200);
        expect(JSON.stringify(patch.body)).not.toContain('sk_live_other');
        const cleared = await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(token)).send({ changes: { apiKey: null } }).expect(200);
        expect(cleared.body.section.entries.find((e: any) => e.key === 'apiKey')).toMatchObject({ value: null, isSet: false });
    });

    it('custom: today\'s custom bag as a provider (add, change, remove keys)', async () => {
        const before = await request(app).get(`${V1}/config/custom`).set(bearer(token)).expect(200);
        expect(before.body.sections[0]).toMatchObject({ id: 'custom', allowCustomKeys: true, version: '0', entries: [] });
        await request(app).patch(`${V1}/config/custom/custom`).set(bearer(token)).send({ changes: { theme: 'dark', maxLogSize: 500 }, version: '0' }).expect(200);
        const res = await request(app).patch(`${V1}/config/custom/custom`).set(bearer(token)).send({ changes: { theme: null }, version: '1' }).expect(200);
        expect(res.body.section.entries.map((e: any) => [e.key, e.value])).toEqual([['maxLogSize', 500]]);
    });

    it('publishes config:changed on every change', async () => {
        const count = events.length;
        await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(token)).send({ changes: { dueDays: 20 } }).expect(200);
        expect(events.length).toBe(count + 1);
        expect(events.at(-1)).toMatchObject({
            type: 'config:changed',
            audience: { permission: 'config:read' },
            data: { provider: 'billing', section: 'invoices', keys: ['dueDays'], user: 'admin' },
        });
    });

    it('the old PUT is gone', async () => {
        await request(app).put(`${V1}/config`).set(bearer(token)).send({ theme: 'dark' }).expect(404);
    });
});

// ------------------------------------------------------------------ protected server

describe('config API on a server protected by the users plugin', () => {
    let cli: CliServerResult;
    let users: UsersPluginResult;
    let admin: CliAdminPluginResult;
    let app: express.Express;
    const tokens: Record<string, string> = {};

    const login = async (username: string, password: string) => {
        const res = await request(app).post(`${V1}/sessions`).send({ username, password });
        if (res.status !== 201) throw new Error(`login ${username}: ${res.status}`);
        return res.body.token as string;
    };

    beforeAll(async () => {
        cli = createCliServer({
            configure: (b) => {
                b.addConfigProvider(billing());
                b.addConfigProvider(billing('vault:admin'));
            },
        });
        users = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build();
        await users.ready;
        admin = new CliAdminBuilder()
            .setJwtSecret('jwt')
            .setAuthProvider(users.serverAuth)
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
        admin.logBuffer.restoreConsole();
        cli.mountPlugin(admin);
        cli.mountPlugin(users);
        app = cli.app;
        tokens.root = await login('root', ROOT_PASS);
        const group = (name: string, permissions: string[]) =>
            request(app).post(`${V1}/groups`).set(bearer(tokens.root)).send({ name, permissions }).expect(201);
        const user = (name: string, groups: string[]) =>
            request(app).post(`${V1}/users`).set(bearer(tokens.root)).send({ name, email: `${name}@x.io`, password: `${name}pass`, groups }).expect(201);
        await group('noconfig', ['admin:access']);
        await group('readers', ['admin:access', 'config:read']);
        await group('writers', ['admin:access', 'config:read', 'config:write']);
        await group('vaulters', ['admin:access', 'config:read', 'config:write', 'vault:admin']);
        await user('nora', ['noconfig']);
        await user('rita', ['readers']);
        await user('will', ['writers']);
        await user('vera', ['vaulters']);
        for (const name of ['nora', 'rita', 'will', 'vera']) tokens[name] = await login(name, `${name}pass`);
    });
    afterAll(() => {
        users.dispose();
        admin.dispose();
    });

    it('401 without a session', async () => {
        await request(app).get(`${V1}/config`).expect(401);
    });

    it('403 without config:read', async () => {
        const res = await request(app).get(`${V1}/config`).set(bearer(tokens.nora)).expect(403);
        expect(res.body.error).toContain('config:read');
    });

    it('config:read sees the providers, not those needing another permission; writable is false', async () => {
        const res = await request(app).get(`${V1}/config`).set(bearer(tokens.rita)).expect(200);
        const ids = res.body.providers.map((p: any) => p.id);
        expect(ids).toContain('billing');
        expect(ids).toContain('users');
        expect(ids).not.toContain('vault');
        expect(res.body.providers.every((p: any) => p.writable === false)).toBe(true);
        await request(app).get(`${V1}/config/vault`).set(bearer(tokens.rita)).expect(403);
    });

    it('PATCH needs config:write', async () => {
        const res = await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(tokens.rita)).send({ changes: { dueDays: 5 } }).expect(403);
        expect(res.body.error).toContain('config:write');
    });

    it('config:write changes; a provider requiredPermission guards it too', async () => {
        const res = await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(tokens.will)).send({ changes: { dueDays: 5 }, version: '0' }).expect(200);
        expect(res.body.version).toBe('1');
        await request(app).patch(`${V1}/config/vault/invoices`).set(bearer(tokens.will)).send({ changes: { dueDays: 5 } }).expect(403);
        await request(app).patch(`${V1}/config/vault/invoices`).set(bearer(tokens.vera)).send({ changes: { dueDays: 6 } }).expect(200);
        const writable = await request(app).get(`${V1}/config/billing`).set(bearer(tokens.will)).expect(200);
        expect(writable.body.writable).toBe(true);
    });

    it("audits config.update in the users plugin's audit log, secrets masked", async () => {
        await request(app).patch(`${V1}/config/billing/invoices`).set(bearer(tokens.will)).send({ changes: { apiKey: 'never-log-me', dueDays: 9 } }).expect(200);
        const entries = await users.auditStore.getEntries({ event: 'config.update' });
        const entry = entries.find((e) => (e.properties as any)?.changes?.some((c: any) => c.key === 'apiKey'))!;
        expect(entry).toMatchObject({ event: 'config.update', username: 'will', actor: 'will', target: 'config:billing.invoices' });
        expect((entry.properties as any).changes).toEqual([
            { key: 'apiKey', old: null, new: '***' },
            { key: 'dueDays', old: 5, new: 9 },
        ]);
        expect((entry.properties as any).via).toBe('api');
        expect(JSON.stringify(entries)).not.toContain('never-log-me');
    });

    it('the users provider changes the session timeout of the running plugin', async () => {
        const res = await request(app).get(`${V1}/config/users`).set(bearer(tokens.root)).expect(200);
        const sessions = res.body.sections.find((s: any) => s.id === 'sessions');
        expect(sessions.entries.find((e: any) => e.key === 'sessionTimeout').value).toBe('30m');
        await request(app)
            .patch(`${V1}/config/users/sessions`)
            .set(bearer(tokens.root))
            .send({ changes: { sessionTimeout: '2h' }, version: sessions.version })
            .expect(200);
        expect(users.authService.sessionTimeoutMs).toBe(7_200_000);
        const bad = await request(app).patch(`${V1}/config/users/sessions`).set(bearer(tokens.root)).send({ changes: { sessionTimeout: '10s' } }).expect(400);
        expect(bad.body.errors).toEqual({ sessionTimeout: 'must be at least 1m' });
        const ro = await request(app).patch(`${V1}/config/users/access`).set(bearer(tokens.root)).send({ changes: { protectServer: false } }).expect(400);
        expect(ro.body.error).toBe('config section users.access is read-only');
        await request(app).patch(`${V1}/config/users/sessions`).set(bearer(tokens.root)).send({ changes: { sessionTimeout: null } }).expect(200);
        expect(users.authService.sessionTimeoutMs).toBe(30 * 60_000);
    });

    it('auth provider reports the users sign-in mode', async () => {
        const res = await request(app).get(`${V1}/config/auth`).set(bearer(tokens.rita)).expect(200);
        expect(res.body.sections[0].entries.find((e: any) => e.key === 'mode').value).toBe('users');
    });
});
