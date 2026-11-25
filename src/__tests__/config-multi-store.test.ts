/**
 * A config store per provider: the resolution order (the host's store for the id, the
 * provider's own, the default store, memory), providers in different stores and one store
 * shared by two, versions and conflicts per store, ready() over every store, the plugin
 * builders' setConfigStore, and what GET /config, MCP, config list, the audit entry and the
 * config:changed event say about each provider's store.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
    CliStoredConfigProvider,
    InMemoryConfigStore,
    JsonFileConfigStore,
    cliConfigContext,
    createCustomConfigProvider,
    type AuditEntry,
    type CliConfigStoreDescription,
    type CliConfigStoredSection,
    type CliConfigValue,
    type CliEvent,
    type ICliConfigProvider,
    type ICliConfigStore,
} from '@qodalis/cli-server-abstractions';
import { CliDatabaseConfigStore, sqliteConnection } from '@qodalis/cli-server-plugin-databases';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { CliConfigRegistry } from '../config/cli-config-registry';
import { CliConfigService } from '../config/cli-config-service';
import { CliEventBus } from '../services/cli-event-bus';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';
import { CliUsersBuilder } from '../../plugins/users/index';
import { CliPortalBuilder } from '@qodalis/cli-server-plugin-portal';

const V1 = '/api/v1/qcli';
const all = cliConfigContext(undefined, 'api');

/** A store recording its writes, described as `name`. */
class NamedStore extends InMemoryConfigStore {
    readonly writes: string[] = [];
    constructor(
        readonly name: string,
        private readonly kind: CliConfigStoreDescription['kind'] = 'custom',
    ) {
        super();
    }
    describe(): CliConfigStoreDescription {
        return { kind: this.kind, title: this.name, detail: `${this.name}-detail`, persistent: this.kind !== 'memory' };
    }
    async write(provider: string, section: string, changes: Record<string, CliConfigValue | null>, expected?: number): Promise<CliConfigStoredSection> {
        this.writes.push(`${provider}.${section}`);
        return super.write(provider, section, changes, expected);
    }
}

function provider(id: string, store?: ICliConfigStore, applied?: Record<string, unknown>) {
    return new CliStoredConfigProvider({
        id,
        title: id[0].toUpperCase() + id.slice(1),
        ...(store ? { store } : {}),
        sections: [
            {
                id: 'main',
                settings: [
                    { key: 'limit', type: 'number', default: 5, apply: (v) => applied && (applied.limit = v) },
                    { key: 'name', type: 'string', default: 'x' },
                ],
            },
        ],
    });
}

function readOnly(id: string): ICliConfigProvider {
    return { id, title: id, getSections: () => [{ id: 'main', entries: [{ key: 'k', type: 'string', value: 'v' }] }] };
}

// ------------------------------------------------------------------ resolution

describe('CliConfigRegistry: which store a provider gets', () => {
    it('the host store for the id, then the provider own, then the default store, then memory', () => {
        const hostStore = new NamedStore('host');
        const ownStore = new NamedStore('own');
        const otherOwn = new NamedStore('other-own');
        const defaultStore = new NamedStore('default');

        const r = new CliConfigRegistry();
        const byHost = provider('byhost', ownStore);
        const byOwn = provider('byown', otherOwn);
        const byDefault = provider('bydefault');
        r.add(byHost);
        r.add(byOwn);
        r.add(byDefault);
        r.add(readOnly('info'));

        // Without anything set: memory (the registry's default)
        expect(r.storeOf(byDefault)).toBe(r.defaultStore);
        expect(r.defaultStore.source).toBe('runtime');

        r.setStore(defaultStore);
        r.setStore(hostStore, 'byhost');
        expect(r.storeOf('byhost')).toBe(hostStore);
        expect(r.storeOf('byown')).toBe(otherOwn);
        expect(r.storeOf('bydefault')).toBe(defaultStore);
        expect(r.storeOf('info')).toBeUndefined();
        expect(r.storeOf('missing')).toBeUndefined();

        r.start();
        // What the providers were given
        expect(byHost.store).toBe(hostStore);
        expect(byHost.ownStore).toBe(ownStore);
        expect(byOwn.store).toBe(otherOwn);
        expect(byDefault.store).toBe(defaultStore);
        expect(r.stores).toEqual([defaultStore, hostStore, otherOwn]);
        expect([...r.providerStores.keys()]).toEqual(['byhost']);
    });

    it('a provider with no store anywhere keeps its changes in memory', async () => {
        const r = new CliConfigRegistry();
        const p = provider('plain');
        r.add(p);
        r.start();
        expect(describeOf(r, 'plain')).toEqual({ kind: 'memory', title: 'In memory', detail: '', persistent: false });
        // And a provider that is never registered uses its own store, else memory
        const own = new NamedStore('own');
        const alone = provider('alone', own);
        await alone.update('main', { limit: 7 }, undefined);
        expect(own.writes).toEqual(['alone.main']);
        const bare = provider('bare');
        await bare.update('main', { limit: 8 }, undefined);
        expect(bare.value('main', 'limit')).toBe(8);
    });

    it('the provider own store can be set after construction (setStore), not once registered', () => {
        const r = new CliConfigRegistry();
        const own = new NamedStore('own');
        const p = provider('later').setStore(own);
        expect(p.ownStore).toBe(own);
        r.add(p);
        r.start();
        expect(p.store).toBe(own);
        expect(() => p.setStore(new NamedStore('too-late'))).toThrow('the config store of later must be set before the provider is registered');
    });

    it('a store for an id may be set after the server started, until that provider is registered', () => {
        const r = new CliConfigRegistry();
        r.start();
        const late = new NamedStore('late');
        r.setStore(late, 'plugin');
        const p = provider('plugin');
        r.add(p);
        expect(p.store).toBe(late);
        expect(() => r.setStore(new NamedStore('again'), 'plugin')).toThrow('the config store of plugin must be set before the provider is registered');
        expect(() => r.setStore(new NamedStore('default'))).toThrow('the config store must be set before the server is created');
    });

    it('refuses a store without read and write, and an invalid provider id', () => {
        const r = new CliConfigRegistry();
        expect(() => r.setStore({} as ICliConfigStore)).toThrow('invalid config store: it needs read and write');
        expect(() => r.setStore(new NamedStore('x'), 'Bad Id')).toThrow('invalid config provider id: Bad Id');
    });

    it('stored values are applied from each provider own store when the server starts', async () => {
        const a = new NamedStore('a');
        const b = new NamedStore('b');
        await a.write('first', 'main', { limit: 1 });
        await b.write('second', 'main', { limit: 2 });
        // The same provider id in the other store is ignored
        await b.write('first', 'main', { limit: 99 });
        const appliedFirst: Record<string, unknown> = {};
        const appliedSecond: Record<string, unknown> = {};
        const r = new CliConfigRegistry();
        r.setStore(a, 'first');
        r.add(provider('first', undefined, appliedFirst));
        r.add(provider('second', b, appliedSecond));
        r.start();
        await r.ready();
        expect(appliedFirst.limit).toBe(1);
        expect(appliedSecond.limit).toBe(2);
    });
});

function describeOf(r: CliConfigRegistry, id: string) {
    return new CliConfigService(r).describeProviderStore(id);
}

// ------------------------------------------------------------------ providers in different stores, a shared store

describe('providers in different stores', () => {
    let fileDir: string;
    beforeEach(() => {
        fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-multi-store-'));
    });
    afterEach(() => fs.rmSync(fileDir, { recursive: true, force: true }));

    function setup(stores: { default?: ICliConfigStore; byId?: Record<string, ICliConfigStore> }, providers: ICliConfigProvider[]) {
        const registry = new CliConfigRegistry();
        if (stores.default) registry.setStore(stores.default);
        for (const [id, store] of Object.entries(stores.byId ?? {})) registry.setStore(store, id);
        for (const p of providers) registry.add(p);
        registry.start();
        const audits: AuditEntry[] = [];
        const bus = new CliEventBus();
        const events: CliEvent[] = [];
        bus.subscribe('config:*', (e) => void events.push(e));
        const service = new CliConfigService(registry, { audit: () => async (e) => void audits.push(e), eventBus: () => bus });
        return { registry, service, audits, events };
    }

    it('two providers in two stores each write and read their own (a JSON file and a database)', async () => {
        const file = new JsonFileConfigStore(path.join(fileDir, 'settings.json'));
        const db = new Database(':memory:');
        const database = new CliDatabaseConfigStore({ connection: sqliteConnection(db) });
        const { service } = setup({ byId: { jobs: database } }, [provider('jobs'), provider('users', file)]);
        await service.ready();

        await service.update('jobs', 'main', { changes: { limit: 7 } }, all);
        await service.update('users', 'main', { changes: { limit: 3, name: 'u' } }, all);
        await service.update('jobs', 'main', { changes: { name: 'j' } }, all);

        // Each store holds only its provider
        expect(await database.read('jobs', 'main')).toEqual({ values: { limit: 7, name: 'j' }, version: 2 });
        expect(await database.read('users', 'main')).toEqual({ values: {}, version: 0 });
        expect(JSON.parse(fs.readFileSync(path.join(fileDir, 'settings.json'), 'utf8'))).toEqual({ users: { main: { values: { limit: 3, name: 'u' }, version: 1 } } });
        const rows = db.prepare('SELECT "Provider", "Section", "Version" FROM "QcliConfig"').all();
        expect(rows).toEqual([{ Provider: 'jobs', Section: 'main', Version: 2 }]);

        // And each reads back its own values and version
        const jobs = await service.get('jobs', all);
        const users = await service.get('users', all);
        expect(jobs.sections[0].entries.map((e) => [e.key, e.value, e.source])).toEqual([
            ['limit', 7, 'database'],
            ['name', 'j', 'database'],
        ]);
        expect(jobs.sections[0].version).toBe('2');
        expect(users.sections[0].entries.map((e) => [e.key, e.value, e.source])).toEqual([
            ['limit', 3, 'file'],
            ['name', 'u', 'file'],
        ]);
        expect(users.sections[0].version).toBe('1');
        expect(jobs.store).toEqual({ kind: 'database', title: 'Database', detail: 'SQLite, table QcliConfig', persistent: true });
        expect(users.store).toEqual({ kind: 'file', title: 'JSON file', detail: 'settings.json', persistent: true });
        db.close();
    });

    it('one store shared by two providers keeps their data apart', async () => {
        const shared = new NamedStore('shared');
        const { service, registry } = setup({ byId: { alpha: shared } }, [provider('alpha'), provider('beta', shared), provider('gamma')]);
        await service.update('alpha', 'main', { changes: { limit: 1 } }, all);
        await service.update('beta', 'main', { changes: { limit: 2 } }, all);
        await service.update('beta', 'main', { changes: { limit: 3 } }, all);
        expect(shared.writes).toEqual(['alpha.main', 'beta.main', 'beta.main']);
        expect(await shared.read('alpha', 'main')).toEqual({ values: { limit: 1 }, version: 1 });
        expect(await shared.read('beta', 'main')).toEqual({ values: { limit: 3 }, version: 2 });
        // gamma uses the default (memory): untouched by the others
        expect((await service.get('gamma', all)).sections[0].version).toBe('0');
        expect(registry.stores.filter((s) => s === shared)).toHaveLength(1);
        const views = await service.list(all);
        expect(views.find((v) => v.id === 'alpha')!.store).toEqual(views.find((v) => v.id === 'beta')!.store);
    });

    it('versions and conflicts are per store: a stale version in one store does not touch the other', async () => {
        const left = new NamedStore('left');
        const right = new NamedStore('right');
        const { service, audits, events } = setup({ default: left, byId: { right: right } }, [provider('left'), provider('right')]);
        await service.update('left', 'main', { changes: { limit: 1 }, version: '0' }, all);
        await service.update('left', 'main', { changes: { limit: 2 }, version: '1' }, all);
        // right is still at version 0 in its own store
        await expect(service.update('right', 'main', { changes: { limit: 9 }, version: '2' }, all)).rejects.toMatchObject({ status: 409, version: '0' });
        await service.update('right', 'main', { changes: { limit: 9 }, version: '0' }, all);
        // A stale version against left is refused with left's version, right unaffected
        await expect(service.update('left', 'main', { changes: { limit: 3 }, version: '1' }, all)).rejects.toMatchObject({ status: 409, version: '2' });
        // A store refusing on its own (another server wrote meanwhile) is a 409 too
        await right.write('right', 'main', { name: 'by-another-server' });
        const stale = await service.update('right', 'main', { changes: { limit: 4 }, version: '1' }, all).catch((e) => e);
        expect(stale).toMatchObject({ status: 409, version: '2' });
        expect(await left.read('left', 'main')).toEqual({ values: { limit: 2 }, version: 2 });
        expect(await right.read('right', 'main')).toEqual({ values: { limit: 9, name: 'by-another-server' }, version: 2 });
        // Only successful writes are audited and published
        expect(audits.map((a) => `${(a.properties as any).provider}@${(a.properties as any).version}`)).toEqual(['left@1', 'left@2', 'right@1']);
        expect(events).toHaveLength(3);
    });

    it('the audit entry and the config:changed event name the kind of store written', async () => {
        const file = new JsonFileConfigStore(path.join(fileDir, 'c.json'));
        const custom = new NamedStore('vault', 'custom');
        const { service, audits, events } = setup({ default: file, byId: { secret: custom } }, [provider('plain'), provider('secret')]);
        await service.update('plain', 'main', { changes: { limit: 2 } }, all);
        await service.update('secret', 'main', { changes: { limit: 3 } }, all);
        expect(audits.map((a) => (a.properties as any).store)).toEqual(['file', 'custom']);
        expect(events.map((e) => (e.data as any).store)).toEqual(['file', 'custom']);
        // The kind only: never the detail (paths, hosts)
        expect(JSON.stringify(audits)).not.toContain('c.json');
        expect(JSON.stringify(events)).not.toContain('vault-detail');
        expect(audits[0].properties).toEqual({ provider: 'plain', section: 'main', version: '1', store: 'file', via: 'api', changes: [{ key: 'limit', old: 5, new: 2 }] });
        expect(events[1].data).toEqual({ provider: 'secret', section: 'main', keys: ['limit'], version: '1', requiresRestart: false, store: 'custom' });
    });

    it('a writer that saves itself (no store) is audited without a store', async () => {
        const selfSaving: ICliConfigProvider & { validate: () => object; update: () => Promise<any> } = {
            id: 'self',
            title: 'Self',
            getSections: () => [{ id: 'main', version: '1', entries: [{ key: 'k', type: 'string', value: 'v', mutable: true }] }],
            validate: () => ({}),
            update: async () => ({ applied: ['k'], requiresRestart: false, version: '2' }),
        };
        const { service, audits, events } = setup({}, [selfSaving]);
        await service.update('self', 'main', { changes: { k: 'w' } }, all);
        expect((audits[0].properties as any).store).toBeUndefined();
        expect((events[0].data as any).store).toBeUndefined();
        expect((await service.get('self', all)).store).toBeUndefined();
    });
});

// ------------------------------------------------------------------ ready()

describe('config.ready() over every store', () => {
    it('waits for each store own ready and every provider loading from its store', async () => {
        let release!: () => void;
        const slow = Object.assign(new NamedStore('slow'), { ready: new Promise<void>((r) => (release = r)) });
        let functionReadyCalled = false;
        const withFn = Object.assign(new NamedStore('fn'), {
            ready: async () => {
                functionReadyCalled = true;
            },
        });
        const cli = createCliServer({ config: { store: slow, stores: { fn: withFn } }, configure: (b) => b.addConfigProvider(provider('fn')) });
        let done = false;
        const ready = cli.config.ready().then(() => (done = true));
        await new Promise((r) => setTimeout(r, 10));
        expect(done).toBe(false);
        release();
        await ready;
        expect(done).toBe(true);
        expect(functionReadyCalled).toBe(true);
    });

    it('rejects when one of the stores fails, even one only a single provider uses', async () => {
        const failing: ICliConfigStore = {
            source: 'database',
            read: () => Promise.reject(new Error('redis down')),
            write: () => Promise.reject(new Error('redis down')),
        };
        const cli = createCliServer({ config: { stores: { jobs: failing } }, configure: (b) => b.addConfigProvider(provider('jobs')) });
        await expect(cli.config.ready()).rejects.toThrow('redis down');
    });
});

// ------------------------------------------------------------------ the server: options, builders, API, MCP, terminal

describe('a server with providers in several stores', () => {
    let cli: CliServerResult;
    let admin: CliAdminPluginResult;
    let app: express.Express;
    let token: string;
    let dir: string;
    let db: Database.Database;
    const jobsOwn = new NamedStore('jobs-own');
    const logsStore = new NamedStore('logs-store', 'custom');
    const redisLike = new NamedStore('Redis', 'redis');

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-multi-server-'));
        fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ app: { name: 'demo' } }, null, 2));
        db = new Database(':memory:');
        const database = new CliDatabaseConfigStore({ connection: sqliteConnection(db), database: 'qcli-demo.sqlite' });
        cli = createCliServer({
            mcp: true,
            config: {
                store: new JsonFileConfigStore(path.join(dir, 'app.json'), { section: 'qcli' }),
                // jobs: the host's store wins over the one the jobs builder sets
                stores: { jobs: database, custom: redisLike },
            },
            configure: (b) => b.addConfigProvider(provider('billing')).setConfigStore(redisLike, 'billing'),
        });
        admin = new CliAdminBuilder()
            .setCredentials('admin', 'adminpass')
            .setJwtSecret('jwt-secret-for-tests')
            .setConfigStore(logsStore)
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
        admin.logBuffer.restoreConsole();
        cli.mountPlugin(new CliJobsBuilder().setConfigStore(jobsOwn).build());
        cli.mountPlugin(admin);
        app = cli.app;
        await cli.config.ready();
        token = (await request(app).post(`${V1}/auth/login`).send({ username: 'admin', password: 'adminpass' })).body.token;
    });
    afterAll(() => {
        admin.dispose();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('GET /config: defaultStore, and a store on every stored provider (none on read-only ones)', async () => {
        const res = await request(app).get(`${V1}/config`).set({ Authorization: `Bearer ${token}` }).expect(200);
        expect(Object.keys(res.body).sort()).toEqual(['defaultStore', 'providers']);
        expect(res.body.defaultStore).toEqual({ kind: 'file', title: 'JSON file', detail: 'app.json, section qcli', persistent: true });
        const stores = Object.fromEntries(res.body.providers.map((p: any) => [p.id, p.store ?? null]));
        expect(stores).toEqual({
            server: null,
            auth: null,
            host: null,
            cors: { kind: 'file', title: 'JSON file', detail: 'app.json, section qcli', persistent: true },
            mcp: { kind: 'file', title: 'JSON file', detail: 'app.json, section qcli', persistent: true },
            logs: { kind: 'custom', title: 'logs-store', detail: 'logs-store-detail', persistent: true },
            // the dashboard plugins' settings: no store of their own, the default one
            'dashboard-plugins': { kind: 'file', title: 'JSON file', detail: 'app.json, section qcli', persistent: true },
            jobs: { kind: 'database', title: 'Database', detail: 'SQLite database qcli-demo.sqlite, table QcliConfig', persistent: true },
            billing: { kind: 'redis', title: 'Redis', detail: 'Redis-detail', persistent: true },
            custom: { kind: 'redis', title: 'Redis', detail: 'Redis-detail', persistent: true },
        });
        // Every provider keeps its storage; a stored one says store
        const jobs = res.body.providers.find((p: any) => p.id === 'jobs');
        expect(jobs.storage).toEqual({ kind: 'store', description: 'Changes are saved to its config store', sources: [] });
        expect(Object.keys(jobs)).toEqual(['id', 'title', 'description', 'order', 'writable', 'storage', 'store', 'sections']);
    });

    it('GET /config/{provider}: the provider with its store', async () => {
        const res = await request(app).get(`${V1}/config/jobs`).set({ Authorization: `Bearer ${token}` }).expect(200);
        expect(res.body.store.kind).toBe('database');
        const server = await request(app).get(`${V1}/config/server`).set({ Authorization: `Bearer ${token}` }).expect(200);
        expect(server.body.store).toBeUndefined();
    });

    it('PATCH writes to the provider own store only, and the rest of the app settings file stays', async () => {
        await request(app)
            .patch(`${V1}/config/jobs/history`)
            .set({ Authorization: `Bearer ${token}` })
            .send({ changes: { maxRunsPerJob: 25 }, version: '0' })
            .expect(200);
        await request(app)
            .patch(`${V1}/config/logs/buffer`)
            .set({ Authorization: `Bearer ${token}` })
            .send({ changes: { minLevel: 'WARN' } })
            .expect(200);
        await request(app)
            .patch(`${V1}/config/custom/custom`)
            .set({ Authorization: `Bearer ${token}` })
            .send({ changes: { motd: 'hi' } })
            .expect(200);
        await request(app)
            .patch(`${V1}/config/cors/cors`)
            .set({ Authorization: `Bearer ${token}` })
            .send({ changes: { allowedOrigins: ['https://a.example'] } })
            .expect(200);
        const rows = db.prepare('SELECT "Provider", "Section", "Data" FROM "QcliConfig"').all();
        expect(rows).toEqual([{ Provider: 'jobs', Section: 'history', Data: JSON.stringify({ maxRunsPerJob: 25 }) }]);
        expect(jobsOwn.writes).toEqual([]);
        expect(logsStore.writes).toEqual(['logs.buffer']);
        expect(redisLike.writes).toEqual(['custom.custom']);
        const file = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
        expect(file.app).toEqual({ name: 'demo' });
        expect(Object.keys(file.qcli)).toEqual(['cors']);
    });

    it('MCP config_list and config_get carry each provider store', async () => {
        const rpc = async (name: string, args: Record<string, unknown> = {}) =>
            (await request(app).post('/api/qcli/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
        const list = (await rpc('config_list')).structuredContent;
        expect(list.defaultStore.detail).toBe('app.json, section qcli');
        expect(list.store).toBeUndefined();
        expect(list.providers.find((p: any) => p.id === 'jobs').store.kind).toBe('database');
        expect(list.providers.find((p: any) => p.id === 'server').store).toBeUndefined();
        const get = (await rpc('config_get', { provider: 'billing' })).structuredContent;
        expect(get.provider.store).toEqual({ kind: 'redis', title: 'Redis', detail: 'Redis-detail', persistent: true });
    });

    it('config list: the default store first, then each stored provider with its store', async () => {
        const res = await request(app)
            .post(`${V1}/execute`)
            .set({ Authorization: `Bearer ${token}` })
            .send({ command: 'config', chainCommands: ['list'], rawCommand: 'config list' });
        const text: string = (res.body?.outputs ?? []).map((o: any) => o.value).join('\n');
        const heads = text.split('\n').filter((l) => !l.startsWith('  '));
        expect(heads).toEqual([
            'Default store: JSON file (app.json, section qcli), kept across restarts',
            'server  Server  (read-only)',
            'auth  Authentication  (read-only)',
            'host  Host  (read-only; from Server options, Environment variables)',
            'cors  CORS  · JSON file (app.json, section qcli)',
            'mcp  MCP  · JSON file (app.json, section qcli)',
            'jobs  Jobs  · Database (SQLite database qcli-demo.sqlite, table QcliConfig)',
            'logs  Logs  · logs-store (logs-store-detail)',
            'dashboard-plugins  Dashboard plugins  · JSON file (app.json, section qcli)',
            'billing  Billing  · Redis (Redis-detail)',
            'custom  Custom  · Redis (Redis-detail)',
        ]);
    });
});

describe('createCliServer config.stores and builder.setConfigStore(store, id) are the same', () => {
    it('both set the store of one provider; createCustomConfigProvider takes a store', async () => {
        const a = new NamedStore('a');
        const b = new NamedStore('b');
        const viaOptions = createCliServer({ config: { stores: { billing: a } }, configure: (x) => x.addConfigProvider(provider('billing')) });
        const viaBuilder = createCliServer({ configure: (x) => x.setConfigStore(b, 'billing').addConfigProvider(provider('billing')) });
        expect(viaOptions.config.describeProviderStore('billing')!.title).toBe('a');
        expect(viaBuilder.config.describeProviderStore('billing')!.title).toBe('b');
        const own = new NamedStore('own');
        const custom = createCustomConfigProvider({ id: 'extra', store: own });
        expect(custom.ownStore).toBe(own);
    });
});

describe('the plugin builders give their provider its own store', () => {
    it('jobs, users, portal and admin (logs): setConfigStore sets the provider own store; none by default', () => {
        const store = new NamedStore('plugin');
        const jobs = new CliJobsBuilder().setConfigStore(store).build();
        const users = new CliUsersBuilder().setDefaultAdminPassword('rootpass1').setConfigStore(store).build();
        const portal = new CliPortalBuilder().setConfigStore(store).build();
        const own = (providers: ICliConfigProvider[] | undefined, id: string) => (providers ?? []).find((p) => p.id === id) as CliStoredConfigProvider;
        expect(own(jobs.configProviders, 'jobs').ownStore).toBe(store);
        expect(own(users.configProviders, 'users').ownStore).toBe(store);
        expect(own(portal.configProviders, 'portal').ownStore).toBe(store);
        users.dispose();
        expect(own(new CliJobsBuilder().build().configProviders, 'jobs').ownStore).toBeUndefined();

        const cli = createCliServer({});
        const admin = new CliAdminBuilder()
            .setCredentials('admin', 'adminpass')
            .setJwtSecret('jwt-secret-for-tests')
            .setConfigStore(store)
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
        admin.logBuffer.restoreConsole();
        expect(cli.config.describeProviderStore('logs')!.title).toBe('plugin');
        expect(cli.config.describeProviderStore('auth')).toBeUndefined();
        admin.dispose();
    });
});
