/**
 * Settings of dashboard plugins from the marketplace (admin plugin): the `dashboard-plugins` config provider with a
 * section per installed plugin with settings (entries and defaults from the version's `config.entries`), install-time
 * values checked before anything is downloaded, values kept or dropped on update, deleted on remove, restored after a
 * restart from installed.json (offline), invalid or secret settings from the marketplace refused, GET
 * /installed/{name}/config, `config set` through the existing command, `config:changed`, the store resolution,
 * permissions, and `admin dashboard install|update --config` and `admin dashboard info`. No network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { InMemoryConfigStore, JsonFileConfigStore, type CliEvent } from '@qodalis/cli-server-abstractions';
import {
    DASHBOARD_PLUGIN_CONFIG_MAX_ENTRIES,
    parseDashboardPluginConfig,
    validateDashboardPluginConfigValues,
} from '../../plugins/admin/index';
import { runCommand, V1 } from './command-test-helpers';
import { BASE, FakeNet, MARKET, TICKETS, auth, cleanupMarketplaceHosts, start, startProtected, type Host } from './dashboard-marketplace-test-helpers';

afterEach(cleanupMarketplaceHosts);

const CONFIG = `${V1}/config`;
const SECTION = `${CONFIG}/dashboard-plugins/tickets`;

/** The settings of the tickets page, version 1. */
const SETTINGS_V1 = {
    entries: [
        { key: 'refreshSeconds', label: 'Refresh every', description: 'Seconds between two refreshes', type: 'number', default: 30, validation: { min: 5, max: 3600 } },
        { key: 'columns', type: 'string[]', default: ['name', 'status'] },
        { key: 'mode', type: 'enum', default: 'compact', validation: { options: ['compact', 'full'] } },
    ],
};

/** Version 2: refreshSeconds at most 30, mode gone, columns unchanged, theme new. */
const SETTINGS_V2 = {
    entries: [
        { key: 'refreshSeconds', label: 'Refresh every', type: 'number', default: 15, validation: { min: 5, max: 30 } },
        { key: 'columns', type: 'string[]', default: ['name'] },
        { key: 'theme', type: 'string', default: 'light', validation: { options: ['light', 'dark'] } },
    ],
};

const configEvents = (h: Host): CliEvent[] => {
    const events: CliEvent[] = [];
    h.cli.eventBus.subscribe('config:*', (e) => void events.push(e));
    return events;
};

const publishTickets = (net: FakeNet, versions: Array<{ version: string; config?: unknown }> = [{ version: '1.0.0', config: SETTINGS_V1 }]) =>
    net.publish(TICKETS, { title: 'Tickets', icon: '🎫', versions });

const cdnCalls = (net: FakeNet) => net.calls.filter((c) => !c.startsWith(MARKET));

describe('dashboard plugin settings: the marketplace record', () => {
    it('parses a config: known fields kept, defaults filled with null, no entries is no settings', () => {
        expect(
            parseDashboardPluginConfig({
                entries: [
                    { key: 'a', type: 'string', extra: 1 },
                    { key: 'b.c-d_e', label: 'B', description: 'The b', type: 'duration', default: '30s', validation: { min: 1000, unknown: true } },
                    { key: 'u', type: 'url', default: 'https://x.io' },
                    { key: 'j', type: 'json', default: { x: [1] } },
                    { key: 'f', type: 'boolean', default: false },
                ],
                other: true,
            }),
        ).toEqual({
            entries: [
                { key: 'a', type: 'string', default: null },
                { key: 'b.c-d_e', label: 'B', description: 'The b', type: 'duration', default: '30s', validation: { min: 1000 } },
                { key: 'u', type: 'url', default: 'https://x.io' },
                { key: 'j', type: 'json', default: { x: [1] } },
                { key: 'f', type: 'boolean', default: false },
            ],
        });
        expect(parseDashboardPluginConfig(undefined)).toBeUndefined();
        expect(parseDashboardPluginConfig(null)).toBeUndefined();
        expect(parseDashboardPluginConfig({ entries: [] })).toBeUndefined();
        expect(parseDashboardPluginConfig({})).toBeUndefined();
    });

    it('refuses a secret entry and every malformed config, with the reason', () => {
        const entry = (e: Record<string, unknown>) => ({ entries: [{ key: 'k', type: 'string', ...e }] });
        const many = { entries: Array.from({ length: DASHBOARD_PLUGIN_CONFIG_MAX_ENTRIES + 1 }, (_, i) => ({ key: `k${i}`, type: 'string' })) };
        const cases: Array<[unknown, string]> = [
            [entry({ type: 'secret' }), 'k: secret settings are not allowed (a dashboard plugin runs in the browser)'],
            ['text', 'config must be an object'],
            [[], 'config must be an object'],
            [{ entries: 'x' }, 'config.entries must be a list'],
            [many, 'config has more than 50 entries'],
            [{ entries: [{ key: 'k', type: 'string', default: 'x'.repeat(33 * 1024) }] }, 'config is larger than 32 KB'],
            [{ entries: ['k'] }, 'every config entry must be an object'],
            [{ entries: [{ key: '1abc', type: 'string' }] }, 'invalid config key: 1abc'],
            [{ entries: [{ key: 'a b', type: 'string' }] }, 'invalid config key: a b'],
            [{ entries: [{ key: 'x'.repeat(65), type: 'string' }] }, `invalid config key: ${'x'.repeat(65)}`],
            [{ entries: [{ key: 'k', type: 'string' }, { key: 'k', type: 'number' }] }, 'duplicate config key: k'],
            [entry({ type: 'color' }), 'k: unknown type color'],
            [entry({ label: 3 }), 'k: label must be a string'],
            [entry({ validation: 'x' }), 'k: validation must be an object'],
            [entry({ validation: { min: '1' } }), 'k: validation.min must be a number'],
            [entry({ validation: { min: 5, max: 1 } }), 'k: validation.min is above validation.max'],
            [entry({ validation: { pattern: '([' } }), 'k: validation.pattern must be a regular expression'],
            [entry({ validation: { options: [1] } }), 'k: validation.options must be a list of strings'],
            [entry({ validation: { required: 'yes' } }), 'k: validation.required must be true or false'],
            [entry({ type: 'enum', default: 'a' }), 'k: an enum needs validation.options'],
            [entry({ type: 'enum', default: 'c', validation: { options: ['a', 'b'] } }), 'k: the default must be one of: a, b'],
            [entry({ type: 'number', default: 1, validation: { min: 5 } }), 'k: the default must be at least 5'],
            [entry({ type: 'number', default: '5' }), 'k: the default must be a number'],
            [entry({ validation: { required: true } }), 'k: the default is required'],
            [entry({ type: 'url', default: 'not a url' }), 'k: the default must be an absolute URL'],
        ];
        for (const [config, reason] of cases) expect(() => parseDashboardPluginConfig(config), reason).toThrow(reason);
    });

    it('checks values against the settings: unknown keys, types and rules; null keeps the default', () => {
        const config = parseDashboardPluginConfig(SETTINGS_V1)!;
        expect(validateDashboardPluginConfigValues(config, { refreshSeconds: 60, columns: ['a'], mode: 'full' })).toEqual({});
        expect(validateDashboardPluginConfigValues(config, { refreshSeconds: null })).toEqual({});
        expect(validateDashboardPluginConfigValues(config, { refreshSeconds: 1, columns: 'a', mode: 'huge', nope: 1 })).toEqual({
            refreshSeconds: 'must be at least 5',
            columns: 'must be a list of strings',
            mode: 'must be one of: compact, full',
            nope: 'unknown setting',
        });
        expect(validateDashboardPluginConfigValues(undefined, { a: 1 })).toEqual({ a: 'unknown setting' });
    });
});

describe('dashboard plugin settings: install', () => {
    it("creates the plugin's section with the version's entries and their defaults", async () => {
        const net = new FakeNet();
        publishTickets(net);
        const h = await start({ net });
        const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: TICKETS, id: 'tickets', hasConfig: true });
        expect(res.body.warnings).toBeUndefined();

        const provider = await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h.token));
        expect(provider.status).toBe(200);
        expect(provider.body).toMatchObject({
            id: 'dashboard-plugins',
            title: 'Dashboard plugins',
            writable: true,
            storage: { kind: 'store' },
            store: { kind: 'memory' },
        });
        expect(provider.body.sections).toEqual([
            {
                id: 'tickets',
                title: 'Tickets',
                description: `${TICKETS}@1.0.0`,
                mutable: true,
                version: '0',
                allowCustomKeys: false,
                entries: [
                    {
                        key: 'refreshSeconds',
                        label: 'Refresh every',
                        description: 'Seconds between two refreshes',
                        type: 'number',
                        value: 30,
                        default: 30,
                        source: 'default', origin: 'default',
                        mutable: true,
                        requiresRestart: false,
                        sensitive: false,
                        validation: { min: 5, max: 3600 },
                    },
                    { key: 'columns', label: 'columns', description: '', type: 'string[]', value: ['name', 'status'], default: ['name', 'status'], source: 'default', origin: 'default', mutable: true, requiresRestart: false, sensitive: false },
                    {
                        key: 'mode',
                        label: 'mode',
                        description: '',
                        type: 'enum',
                        value: 'compact',
                        default: 'compact',
                        source: 'default', origin: 'default',
                        mutable: true,
                        requiresRestart: false,
                        sensitive: false,
                        validation: { options: ['compact', 'full'] },
                    },
                ],
            },
        ]);
        // the entries are kept with the plugin, for restarts
        const saved = JSON.parse(readFileSync(join(h.dir, 'installed.json'), 'utf8'));
        expect(saved.plugins[0].config).toEqual(parseDashboardPluginConfig(SETTINGS_V1));
        // the values the dashboard passes to the page
        const values = await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token));
        expect(values.status).toBe(200);
        expect(values.headers['cache-control']).toBe('no-store');
        expect(values.body).toEqual({ values: { refreshSeconds: 30, columns: ['name', 'status'], mode: 'compact' }, version: '0' });
        // the name encoded works too
        expect((await request(h.cli.app).get(`${BASE}/installed/${encodeURIComponent(TICKETS)}/config`).set(auth(h.token))).body.version).toBe('0');
    });

    it('a plugin without settings gets no section; its config is { values: {}, version: null }', async () => {
        const net = new FakeNet();
        publishTickets(net, [{ version: '1.0.0' }]);
        const h = await start({ net });
        const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS });
        expect(res.body.hasConfig).toBe(false);
        expect((await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h.token))).body.sections).toEqual([]);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body).toEqual({ values: {}, version: null });
        expect(JSON.parse(readFileSync(join(h.dir, 'installed.json'), 'utf8')).plugins[0].config).toBeUndefined();
        // the settings were looked up in the version record: the details had none
        expect(net.calls).toContain(`${MARKET}/api/v1/qcli/marketplace/plugins/${encodeURIComponent(TICKETS)}/versions/1.0.0`);
    });

    it('GET /installed/{name}/config: 404 for a plugin not installed, 400 for an invalid name', async () => {
        const h = await start();
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).status).toBe(404);
        expect((await request(h.cli.app).get(`${BASE}/installed/..%2F..%2Fetc/config`).set(auth(h.token))).status).toBe(400);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`)).status).toBe(401);
    });

    it('reads the settings from the version record when the details leave them out', async () => {
        const net = new FakeNet();
        net.configOnlyInVersionRecord = true;
        publishTickets(net);
        const h = await start({ net });
        expect((await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS })).body.hasConfig).toBe(true);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body.values.mode).toBe('compact');
    });

    it('applies valid values given with the install: stored, audited, config:changed published', async () => {
        const net = new FakeNet();
        publishTickets(net);
        const h = await start({ net });
        const events = configEvents(h);
        const res = await request(h.cli.app)
            .post(`${BASE}/installed`)
            .set(auth(h.token))
            .send({ name: TICKETS, config: { refreshSeconds: 60, mode: 'full', columns: null } });
        expect(res.status).toBe(201);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body).toEqual({
            values: { refreshSeconds: 60, columns: ['name', 'status'], mode: 'full' },
            version: '1',
        });
        const section = (await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h.token))).body.sections[0];
        expect(section.entries.map((e: { key: string; value: unknown; source: string }) => [e.key, e.value, e.source])).toEqual([
            ['refreshSeconds', 60, 'runtime'],
            ['columns', ['name', 'status'], 'default'],
            ['mode', 'full', 'runtime'],
        ]);
        expect(events.map((e) => ({ type: e.type, data: e.data, audience: e.audience }))).toEqual([
            {
                type: 'config:changed',
                data: { provider: 'dashboard-plugins', section: 'tickets', keys: ['refreshSeconds', 'mode'], version: '1', requiresRestart: false, store: 'memory', user: 'admin' },
                audience: { permission: 'config:read' },
            },
        ]);
        expect(h.audit.find((a) => a.event === 'dashboard.plugin.install')?.properties).toEqual({ name: TICKETS, version: '1.0.0', id: 'tickets', config: ['refreshSeconds', 'mode'] });
    });

    it('refuses invalid values with 400 per key before anything is downloaded or stored', async () => {
        const net = new FakeNet();
        publishTickets(net);
        net.publish('@acme/cli-dashboard-plain', { versions: [{ version: '1.0.0' }] });
        const h = await start({ net });
        const events = configEvents(h);
        const res = await request(h.cli.app)
            .post(`${BASE}/installed`)
            .set(auth(h.token))
            .send({ name: TICKETS, config: { refreshSeconds: 1, columns: 'name', mode: 'huge', nope: true } });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'validation failed',
            errors: { refreshSeconds: 'must be at least 5', columns: 'must be a list of strings', mode: 'must be one of: compact, full', nope: 'unknown setting' },
        });
        for (const config of ['{"a":1}', [1], 3]) {
            const bad = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS, config });
            expect(bad.status).toBe(400);
            expect(bad.body).toEqual({ error: 'config must be an object' });
        }
        // values for a plugin without settings
        const plain = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: '@acme/cli-dashboard-plain', config: { a: 1 } });
        expect(plain.status).toBe(400);
        expect(plain.body.errors).toEqual({ a: 'unknown setting' });

        expect(cdnCalls(net)).toEqual([]);
        expect((await request(h.cli.app).get(`${BASE}/installed`).set(auth(h.token))).body).toEqual([]);
        expect((await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h.token))).body.sections).toEqual([]);
        expect(events).toEqual([]);
        expect(h.audit).toEqual([]);
    });

    it('a secret entry or a malformed config from the marketplace installs without settings, with a warning', async () => {
        const net = new FakeNet();
        net.publish('@acme/cli-dashboard-secret', {
            versions: [{ version: '1.0.0', config: { entries: [{ key: 'token', type: 'secret' }, { key: 'ok', type: 'string', default: 'x' }] } }],
        });
        net.publish('@acme/cli-dashboard-broken', { versions: [{ version: '2.0.0', config: { entries: [{ key: 'n', type: 'number', default: 1, validation: { min: 5 } }] } }] });
        net.publish('@acme/cli-dashboard-junk', { versions: [{ version: '3.0.0', config: 'junk' }] });
        const h = await start({ net });
        const install = (name: string, config?: unknown) => request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name, ...(config ? { config } : {}) });

        const secret = await install('@acme/cli-dashboard-secret');
        expect(secret.status).toBe(201);
        expect(secret.body.hasConfig).toBe(false);
        expect(secret.body.warnings).toEqual([
            'the settings of @acme/cli-dashboard-secret@1.0.0 are invalid and were ignored: token: secret settings are not allowed (a dashboard plugin runs in the browser)',
        ]);
        expect((await install('@acme/cli-dashboard-broken')).body.warnings).toEqual([
            'the settings of @acme/cli-dashboard-broken@2.0.0 are invalid and were ignored: n: the default must be at least 5',
        ]);
        expect((await install('@acme/cli-dashboard-junk')).body.warnings).toEqual(['the settings of @acme/cli-dashboard-junk@3.0.0 are invalid and were ignored: config must be an object']);
        expect((await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h.token))).body.sections).toEqual([]);
        expect(JSON.parse(readFileSync(join(h.dir, 'installed.json'), 'utf8')).plugins.every((p: { config?: unknown }) => p.config === undefined)).toBe(true);
        expect((await request(h.cli.app).get(`${BASE}/installed/@acme/cli-dashboard-secret/config`).set(auth(h.token))).body).toEqual({ values: {}, version: null });
    });

    it('values given for a refused config are unknown settings (400, nothing installed)', async () => {
        const net = new FakeNet();
        net.publish('@acme/cli-dashboard-secret', { versions: [{ version: '1.0.0', config: { entries: [{ key: 'token', type: 'secret' }] } }] });
        const h = await start({ net });
        const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: '@acme/cli-dashboard-secret', config: { token: 'abc' } });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'validation failed', errors: { token: 'unknown setting' } });
        expect(cdnCalls(net)).toEqual([]);
    });
});

describe('dashboard plugin settings: update and remove', () => {
    it('keeps the stored values the new version still accepts and drops the others (configDropped)', async () => {
        const net = new FakeNet();
        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }]);
        const h = await start({ net });
        await request(h.cli.app)
            .post(`${BASE}/installed`)
            .set(auth(h.token))
            .send({ name: TICKETS, config: { refreshSeconds: 60, columns: ['id', 'title'], mode: 'full' } })
            .expect(201);
        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }, { version: '2.0.0', config: SETTINGS_V2 }]);
        const events = configEvents(h);

        const res = await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({});
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: TICKETS, version: '2.0.0', hasConfig: true, configDropped: ['refreshSeconds', 'mode'] });
        // refreshSeconds 60 is above the new max, mode is gone; columns kept; theme new at its default
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body).toEqual({
            values: { refreshSeconds: 15, columns: ['id', 'title'], theme: 'light' },
            version: '2',
        });
        const section = (await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h.token))).body.sections[0];
        expect(section.description).toBe(`${TICKETS}@2.0.0`);
        expect(section.entries.map((e: { key: string; source: string }) => `${e.key}:${e.source}`)).toEqual(['refreshSeconds:default', 'columns:runtime', 'theme:default']);
        expect(JSON.parse(readFileSync(join(h.dir, 'installed.json'), 'utf8')).plugins[0].config).toEqual(parseDashboardPluginConfig(SETTINGS_V2));
        expect(events.map((e) => e.data)).toEqual([
            { provider: 'dashboard-plugins', section: 'tickets', keys: ['refreshSeconds', 'mode'], version: '2', requiresRestart: false, store: 'memory', user: 'admin' },
        ]);
        expect(h.audit.find((a) => a.event === 'dashboard.plugin.update')?.properties).toEqual({
            name: TICKETS,
            version: '2.0.0',
            id: 'tickets',
            previousVersion: '1.0.0',
            configDropped: ['refreshSeconds', 'mode'],
        });
    });

    it('nothing to drop: configDropped is empty and nothing is written', async () => {
        const net = new FakeNet();
        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }, { version: '1.1.0', config: SETTINGS_V1 }]);
        const h = await start({ net });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS, version: '1.0.0', config: { refreshSeconds: 90 } }).expect(201);
        const events = configEvents(h);
        const res = await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({});
        expect(res.body).toMatchObject({ version: '1.1.0', configDropped: [] });
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body).toEqual({
            values: { refreshSeconds: 90, columns: ['name', 'status'], mode: 'compact' },
            version: '1',
        });
        expect(events).toEqual([]);
    });

    it('values given with an update are checked against the new version before anything is downloaded, then applied', async () => {
        const net = new FakeNet();
        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }, { version: '2.0.0', config: SETTINGS_V2 }]);
        const h = await start({ net });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS, version: '1.0.0', config: { mode: 'full' } }).expect(201);
        const downloads = cdnCalls(net).length;

        // mode exists in 1.0.0 only, theme in 2.0.0 only
        const bad = await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({ config: { mode: 'full', theme: 'blue' } });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ error: 'validation failed', errors: { mode: 'unknown setting', theme: 'must be one of: light, dark' } });
        expect(cdnCalls(net).length).toBe(downloads);
        expect((await request(h.cli.app).get(`${BASE}/installed`).set(auth(h.token))).body[0].version).toBe('1.0.0');
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body.values.mode).toBe('full');
        expect((await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({ config: 'x' })).body).toEqual({ error: 'config must be an object' });

        const ok = await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({ config: { theme: 'dark', refreshSeconds: 20 } });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ version: '2.0.0', configDropped: ['mode'] });
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body.values).toEqual({ refreshSeconds: 20, columns: ['name'], theme: 'dark' });
        expect(h.audit.find((a) => a.event === 'dashboard.plugin.update')?.properties).toMatchObject({ config: ['theme', 'refreshSeconds'], configDropped: ['mode'] });
    });

    it('a value given for a dropped key keeps it, and null resets a setting', async () => {
        const net = new FakeNet();
        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }, { version: '2.0.0', config: SETTINGS_V2 }]);
        const h = await start({ net });
        await request(h.cli.app)
            .post(`${BASE}/installed`)
            .set(auth(h.token))
            .send({ name: TICKETS, version: '1.0.0', config: { refreshSeconds: 600, columns: ['a'] } })
            .expect(201);
        const res = await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({ config: { refreshSeconds: 25, columns: null } });
        expect(res.body.configDropped).toEqual([]);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body.values).toEqual({ refreshSeconds: 25, columns: ['name'], theme: 'light' });
    });

    it('the same version with values: applied, changed false; an update to a version without settings removes the section', async () => {
        const net = new FakeNet();
        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }]);
        const h = await start({ net });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS, config: { mode: 'full' } }).expect(201);
        const same = await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({ config: { refreshSeconds: 45 } });
        expect(same.body).toMatchObject({ version: '1.0.0', configDropped: [] });
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body.values).toMatchObject({ refreshSeconds: 45, mode: 'full' });
        expect((await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({ config: { refreshSeconds: 1 } })).body.errors).toEqual({
            refreshSeconds: 'must be at least 5',
        });

        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }, { version: '3.0.0' }]);
        const res = await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({});
        expect(res.body).toMatchObject({ version: '3.0.0', hasConfig: false, configDropped: ['mode', 'refreshSeconds'] });
        expect((await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h.token))).body.sections).toEqual([]);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body).toEqual({ values: {}, version: null });
    });

    it("removing a plugin deletes its section and its stored values; installed again it starts from the defaults", async () => {
        const net = new FakeNet();
        publishTickets(net);
        const store = new InMemoryConfigStore();
        const h = await start({ net, config: { stores: { 'dashboard-plugins': store } } });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS, config: { refreshSeconds: 60, mode: 'full' } }).expect(201);
        expect((await store.read('dashboard-plugins', 'tickets')).values).toEqual({ refreshSeconds: 60, mode: 'full' });
        const events = configEvents(h);

        expect((await request(h.cli.app).delete(`${BASE}/installed/${TICKETS}`).set(auth(h.token))).status).toBe(200);
        expect(await store.read('dashboard-plugins', 'tickets')).toEqual({ values: {}, version: 2 });
        expect((await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h.token))).body.sections).toEqual([]);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).status).toBe(404);
        expect((await request(h.cli.app).patch(`${SECTION}`).set(auth(h.token)).send({ changes: { mode: 'full' } })).status).toBe(404);
        expect(events.map((e) => e.data)).toEqual([
            { provider: 'dashboard-plugins', section: 'tickets', keys: ['refreshSeconds', 'mode'], version: '2', requiresRestart: false, store: 'memory', user: 'admin' },
        ]);

        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }).expect(201);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body).toEqual({
            values: { refreshSeconds: 30, columns: ['name', 'status'], mode: 'compact' },
            version: '2',
        });
    });

    it('values left in the store from an earlier install of the page are cleared on install', async () => {
        const net = new FakeNet();
        publishTickets(net);
        const store = new InMemoryConfigStore();
        await store.write('dashboard-plugins', 'tickets', { mode: 'full', stale: 1 });
        const h = await start({ net, config: { stores: { 'dashboard-plugins': store } } });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS, config: { refreshSeconds: 10 } }).expect(201);
        expect((await store.read('dashboard-plugins', 'tickets')).values).toEqual({ refreshSeconds: 10 });
    });
});

describe('dashboard plugin settings: restart and stores', () => {
    it('re-creates the sections from installed.json after a restart, offline, with the stored values', async () => {
        const net = new FakeNet();
        publishTickets(net);
        const first = await start({ net });
        const file = join(first.dir, 'qcli-config.json');
        const stores = { 'dashboard-plugins': new JsonFileConfigStore(file) };
        const h1 = await start({ net, dir: first.dir, config: { stores } });
        await request(h1.cli.app).post(`${BASE}/installed`).set(auth(h1.token)).send({ name: TICKETS, config: { refreshSeconds: 120 } }).expect(201);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ 'dashboard-plugins': { tickets: { values: { refreshSeconds: 120 }, version: 1 } } });

        const offline = new FakeNet();
        offline.marketplaceDown = true;
        const h2 = await start({ net: offline, dir: first.dir, config: { stores: { 'dashboard-plugins': new JsonFileConfigStore(file) } } });
        const provider = (await request(h2.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(h2.token))).body;
        expect(provider.store).toMatchObject({ kind: 'file', persistent: true });
        expect(provider.sections.map((s: { id: string; title: string; version: string }) => [s.id, s.title, s.version])).toEqual([['tickets', 'Tickets', '1']]);
        expect((await request(h2.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h2.token))).body).toEqual({
            values: { refreshSeconds: 120, columns: ['name', 'status'], mode: 'compact' },
            version: '1',
        });
        // changeable after the restart, without the marketplace
        expect((await request(h2.cli.app).patch(SECTION).set(auth(h2.token)).send({ changes: { mode: 'full' }, version: '1' })).status).toBe(200);
        expect(offline.calls).toEqual([]);
    });

    it('an installed.json whose settings became invalid loads the plugin without them', async () => {
        const net = new FakeNet();
        publishTickets(net);
        const first = await start({ net });
        await request(first.cli.app).post(`${BASE}/installed`).set(auth(first.token)).send({ name: TICKETS }).expect(201);
        const path = join(first.dir, 'installed.json');
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        saved.plugins[0].config.entries.push({ key: 'apiKey', type: 'secret' });
        writeFileSync(path, JSON.stringify(saved));
        const second = await start({ net, dir: first.dir });
        expect((await request(second.cli.app).get(`${BASE}/installed`).set(auth(second.token))).body).toEqual([expect.objectContaining({ name: TICKETS, hasConfig: false })]);
        expect((await request(second.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(second.token))).body.sections).toEqual([]);
    });

    it("the provider's store: the host's store for dashboard-plugins, else the default store, else memory", async () => {
        const net = new FakeNet();
        publishTickets(net);
        const own = new InMemoryConfigStore();
        const fallback = new InMemoryConfigStore();
        const withOwn = await start({ net, config: { store: fallback, stores: { 'dashboard-plugins': own } } });
        expect(withOwn.cli.config.registry.storeOf('dashboard-plugins')).toBe(own);
        await request(withOwn.cli.app).post(`${BASE}/installed`).set(auth(withOwn.token)).send({ name: TICKETS, config: { mode: 'full' } }).expect(201);
        expect((await own.read('dashboard-plugins', 'tickets')).values).toEqual({ mode: 'full' });
        expect((await fallback.read('dashboard-plugins', 'tickets')).version).toBe(0);

        const defaultStore = new InMemoryConfigStore();
        const withDefault = await start({ net, config: { store: defaultStore } });
        expect(withDefault.cli.config.registry.storeOf('dashboard-plugins')).toBe(defaultStore);
        await request(withDefault.cli.app).post(`${BASE}/installed`).set(auth(withDefault.token)).send({ name: TICKETS, config: { mode: 'full' } }).expect(201);
        expect((await defaultStore.read('dashboard-plugins', 'tickets')).values).toEqual({ mode: 'full' });

        const plain = await start({ net });
        expect((await request(plain.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(plain.token))).body.store).toEqual({ kind: 'memory', title: 'In memory', detail: '', persistent: false });
        expect(plain.admin.configProviders.map((p) => p.id)).toEqual(['auth', 'logs', 'dashboard-plugins']);
    });
});

describe('dashboard plugin settings: through the config providers', () => {
    it('config set dashboard-plugins.<id>.<key>: validated by the existing command, versions, audit and config:changed', async () => {
        const net = new FakeNet();
        publishTickets(net);
        const h = await start({ net });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }).expect(201);
        const events = configEvents(h);
        const run = (line: string) => runCommand(h.cli, line).then((r) => r.text);

        expect(await run('config set dashboard-plugins.tickets.refreshSeconds 2')).toBe('Error: validation failed\n  refreshSeconds: must be at least 5');
        expect(await run('config set dashboard-plugins.tickets.refreshSeconds soon')).toBe('Error: validation failed\n  refreshSeconds: must be a number');
        expect(await run('config set dashboard-plugins.tickets.mode huge')).toBe('Error: validation failed\n  mode: must be one of: compact, full');
        expect(await run('config set dashboard-plugins.tickets.nope 1')).toBe('Error: validation failed\n  nope: unknown setting');
        expect(await run('config set dashboard-plugins.other.mode full')).toBe('Error: unknown config section: dashboard-plugins.other.mode');
        expect(events).toEqual([]);

        expect(await run('config set dashboard-plugins.tickets.refreshSeconds 60')).toBe('Updated dashboard-plugins.tickets.refreshSeconds = 60 (version 1)');
        expect(await run('config set dashboard-plugins.tickets.columns id,title')).toBe('Updated dashboard-plugins.tickets.columns = ["id","title"] (version 2)');
        expect(await run('config set dashboard-plugins.tickets.mode full --expected-version 1')).toBe('Error: version conflict (current version 2)');
        expect(await run('config get dashboard-plugins.tickets')).toBe(
            [
                'dashboard-plugins.tickets  Tickets  (version 2)',
                '  refreshSeconds  60  [number, runtime]',
                '  columns         ["id","title"]  [string[], runtime]',
                '  mode            compact  [enum, default]',
            ].join('\n'),
        );
        expect(events.map((e) => ({ type: e.type, data: e.data }))).toEqual([
            { type: 'config:changed', data: { provider: 'dashboard-plugins', section: 'tickets', keys: ['refreshSeconds'], version: '1', requiresRestart: false, store: 'memory' } },
            { type: 'config:changed', data: { provider: 'dashboard-plugins', section: 'tickets', keys: ['columns'], version: '2', requiresRestart: false, store: 'memory' } },
        ]);
        expect(h.audit.filter((a) => a.event === 'config.update').map((a) => [a.target, a.properties?.changes])).toEqual([
            ['config:dashboard-plugins.tickets', [{ key: 'refreshSeconds', old: 30, new: 60 }]],
            ['config:dashboard-plugins.tickets', [{ key: 'columns', old: ['name', 'status'], new: ['id', 'title'] }]],
        ]);
        // the page's values follow
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body).toEqual({
            values: { refreshSeconds: 60, columns: ['id', 'title'], mode: 'compact' },
            version: '2',
        });
        // reset to the default
        expect(await run('config reset dashboard-plugins.tickets.refreshSeconds')).toContain('dashboard-plugins.tickets.refreshSeconds');
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body.values.refreshSeconds).toBe(30);
    });

    it('PATCH /config/dashboard-plugins/<id>: 400 per key, 409 on a stale version', async () => {
        const net = new FakeNet();
        publishTickets(net);
        const h = await start({ net });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }).expect(201);
        const bad = await request(h.cli.app).patch(SECTION).set(auth(h.token)).send({ changes: { refreshSeconds: 9999, columns: [1] } });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ error: 'validation failed', errors: { refreshSeconds: 'must be at most 3600', columns: 'must be a list of strings' } });
        const ok = await request(h.cli.app).patch(SECTION).set(auth(h.token)).send({ changes: { mode: 'full' }, version: '0' });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ provider: 'dashboard-plugins', applied: ['mode'], version: '1' });
        const stale = await request(h.cli.app).patch(SECTION).set(auth(h.token)).send({ changes: { mode: 'compact' }, version: '0' });
        expect(stale.status).toBe(409);
        expect(stale.body).toEqual({ error: 'version conflict', version: '1' });
    });
});

describe('dashboard plugin settings: permissions on a protected server', () => {
    it('values need admin:access; changes need config:write through the config API; install-time values need dashboard:install', async () => {
        const h = await startProtected({
            viewer: ['admin:access'],
            reader: ['admin:access', 'config:read'],
            writer: ['admin:access', 'config:read', 'config:write'],
            installer: ['admin:access', 'dashboard:install'],
            outsider: ['files:read'],
        });
        publishTickets(h.net);
        const { tokens } = h;
        const install = (token: string) => request(h.cli.app).post(`${BASE}/installed`).set(auth(token)).send({ name: TICKETS, config: { refreshSeconds: 60 } });

        // install-time values: dashboard:install, not config:write
        expect((await install(tokens.writer)).status).toBe(403);
        const installed = await install(tokens.installer);
        expect(installed.status).toBe(201);
        expect(installed.body.installedBy).toBe('installer');

        // the values: admin:access
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(tokens.viewer))).body.values.refreshSeconds).toBe(60);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(tokens.outsider))).status).toBe(403);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`)).status).toBe(401);

        // the config API: config:read to see, config:write to change
        expect((await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(tokens.viewer))).status).toBe(403);
        expect((await request(h.cli.app).get(`${CONFIG}/dashboard-plugins`).set(auth(tokens.reader))).body.writable).toBe(false);
        expect((await request(h.cli.app).patch(SECTION).set(auth(tokens.reader)).send({ changes: { mode: 'full' } })).status).toBe(403);
        expect((await request(h.cli.app).patch(SECTION).set(auth(tokens.installer)).send({ changes: { mode: 'full' } })).status).toBe(403);
        const changed = await request(h.cli.app).patch(SECTION).set(auth(tokens.writer)).send({ changes: { mode: 'full' } });
        expect(changed.status).toBe(200);
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(tokens.viewer))).body.values).toMatchObject({ refreshSeconds: 60, mode: 'full' });

        // updating with values: dashboard:install
        expect((await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(tokens.writer)).send({ config: { mode: 'compact' } })).status).toBe(403);
        expect((await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(tokens.installer)).send({ config: { mode: 'compact' } })).status).toBe(200);
    });

    it('the command: install --config and update --config need dashboard:install, info admin:access', async () => {
        const h = await startProtected({ viewer: ['admin:access', 'commands:execute'], installer: ['admin:access', 'commands:execute', 'dashboard:install'] });
        publishTickets(h.net);
        const dashboard = h.cli.registry.findProcessor('admin')!.processors!.find((p) => p.command === 'dashboard')!;
        expect(dashboard.processors!.find((p) => p.command === 'info')!.requiredPermissions).toBeUndefined();
        expect((await runCommand(h.cli, `admin dashboard install ${TICKETS} --config '{"mode":"full"}'`, h.tokens.viewer)).status).toBe(403);
        expect((await runCommand(h.cli, `admin dashboard install ${TICKETS} --config '{"mode":"full"}'`, h.tokens.installer)).text).toContain(`Installed ${TICKETS}@1.0.0`);
        expect((await runCommand(h.cli, `admin dashboard info ${TICKETS}`, h.tokens.viewer)).text).toContain('mode            full *');
        expect((await runCommand(h.cli, `admin dashboard update ${TICKETS} --config '{"mode":"compact"}'`, h.tokens.viewer)).status).toBe(403);
    });
});

describe('dashboard plugin settings: the admin dashboard command', () => {
    it("install --config '<json>': applied, per-key errors listed, a bad --config refused", async () => {
        const net = new FakeNet();
        publishTickets(net);
        net.publish('@acme/cli-dashboard-secret', { versions: [{ version: '1.0.0', config: { entries: [{ key: 'token', type: 'secret' }] } }] });
        const h = await start({ net });
        const run = (line: string) => runCommand(h.cli, line).then((r) => r.text);

        expect(await run(`admin dashboard install ${TICKETS} --config '{"refreshSeconds":1,"mode":"huge","nope":1}'`)).toBe(
            ['Error: validation failed', '  refreshSeconds: must be at least 5', '  mode: must be one of: compact, full', '  nope: unknown setting'].join('\n'),
        );
        expect(await run(`admin dashboard install ${TICKETS} --config 'not json'`)).toBe(`Error: invalid --config: use a JSON object, e.g. --config '{"key":"value"}'`);
        expect(await run(`admin dashboard install ${TICKETS} --config '[1]'`)).toBe(`Error: invalid --config: use a JSON object, e.g. --config '{"key":"value"}'`);
        expect(cdnCalls(net)).toEqual([]);

        expect(await run(`admin dashboard install ${TICKETS} --config '{"refreshSeconds":60,"columns":["id"]}'`)).toBe(
            [`Installed ${TICKETS}@1.0.0: the dashboard page "Tickets" (/x/tickets).`, `Its settings: admin dashboard info ${TICKETS}`].join('\n'),
        );
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body.values).toEqual({ refreshSeconds: 60, columns: ['id'], mode: 'compact' });

        expect(await run('admin dashboard install @acme/cli-dashboard-secret')).toBe(
            [
                'Installed @acme/cli-dashboard-secret@1.0.0: the dashboard page "cli-dashboard-secret" (/x/secret).',
                'Warning: the settings of @acme/cli-dashboard-secret@1.0.0 are invalid and were ignored: token: secret settings are not allowed (a dashboard plugin runs in the browser)',
            ].join('\n'),
        );
    });

    it('info <name>: the page, files and settings with their values, defaults and rules', async () => {
        const net = new FakeNet();
        publishTickets(net);
        net.publish('@acme/cli-dashboard-plain', { versions: [{ version: '1.0.0', css: null }] });
        const h = await start({ net });
        const run = (line: string) => runCommand(h.cli, line).then((r) => r.text);
        await run(`admin dashboard install ${TICKETS} --config '{"refreshSeconds":60}'`);
        await run('admin dashboard install @acme/cli-dashboard-plain');

        const info = (await run(`admin dashboard info ${TICKETS}`)).split('\n');
        expect(info[0]).toBe(`${TICKETS}@1.0.0`);
        expect(info[1]).toBe('  Page        Tickets (/x/tickets)');
        expect(info[2]).toMatch(/^ {2}Installed {3}\d{4}-\d\d-\d\d \d\d:\d\d:\d\d by anonymous$/);
        expect(info[3]).toMatch(/^ {2}Files {7}extension\.js \(\d+ bytes\), extension\.css \(\d+ bytes\)$/);
        expect(info.slice(4)).toEqual([
            'Settings (config set dashboard-plugins.tickets.<key> <value>; version 1):',
            'Key             Value              Type      Default            Rule',
            'refreshSeconds  60 *               number    30                 min 5; max 3600',
            'columns         ["name","status"]  string[]  ["name","status"]  -',
            'mode            compact            enum      compact            one of compact, full',
            '* changed from the default',
        ]);
        const plain = (await run('admin dashboard info @acme/cli-dashboard-plain')).split('\n');
        expect(plain[3]).toMatch(/^ {2}Files {7}extension\.js \(\d+ bytes\)$/);
        expect(plain[4]).toBe('  Settings    none');

        const json = JSON.parse(await run(`admin dashboard info ${TICKETS} --json`));
        expect(json).toMatchObject({ plugin: { name: TICKETS, id: 'tickets', hasConfig: true }, configVersion: '1' });
        expect(json.settings[0]).toEqual({ key: 'refreshSeconds', label: 'Refresh every', description: 'Seconds between two refreshes', type: 'number', default: 30, validation: { min: 5, max: 3600 }, value: 60, isDefault: false });

        expect(await run('admin dashboard info @acme/none')).toBe('Error: not installed: @acme/none');
        expect(await run('admin dashboard info ../x')).toBe('Error: invalid package name');
        expect(await run('admin dashboard info')).toBe('Error: name one package: admin dashboard info <name>');
    });

    it('update --config, and the settings it drops reported', async () => {
        const net = new FakeNet();
        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }]);
        const h = await start({ net });
        const run = (line: string) => runCommand(h.cli, line).then((r) => r.text);
        await run(`admin dashboard install ${TICKETS} --config '{"refreshSeconds":120,"mode":"full"}'`);
        expect(await run(`admin dashboard update ${TICKETS} --config '{"mode":"compact"}'`)).toBe(`${TICKETS} is already at 1.0.0, the newest version. Its settings were changed.`);
        expect(await run(`admin dashboard update ${TICKETS} --config '{"mode":"x"}'`)).toBe('Error: validation failed\n  mode: must be one of: compact, full');

        publishTickets(net, [{ version: '1.0.0', config: SETTINGS_V1 }, { version: '2.0.0', config: SETTINGS_V2 }]);
        expect(await run(`admin dashboard update ${TICKETS} --config '{"theme":"dark"}'`)).toBe(
            [
                `Updated ${TICKETS} from 1.0.0 to 2.0.0.`,
                'Settings dropped (the new version no longer accepts them): refreshSeconds, mode',
                `Its settings: admin dashboard info ${TICKETS}`,
            ].join('\n'),
        );
        expect((await request(h.cli.app).get(`${BASE}/installed/${TICKETS}/config`).set(auth(h.token))).body.values).toEqual({ refreshSeconds: 15, columns: ['name'], theme: 'dark' });
    });
});
