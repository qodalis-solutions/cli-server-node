/**
 * Plugins installed from code or the dashboard with the same settings: every official entry point loads with its
 * settings (builder.addPlugin, or a package installed at runtime), a missing required setting gives
 * needs-configuration without stopping startup and the plugin runs once it is saved and the server restarts, the load
 * order (AUTH, CONFIG_STORE, CORE, DEFAULT, SOURCE; code and installed plugins together), requests held until the
 * sign-in loads, a code-added plugin's settings shown and edited (code options as defaults, the saved setting wins,
 * the origin reported, secrets never returned, restart required), each package's qodalis.config matching its entry,
 * and the admin plugin still refused.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { CLI_PLUGIN_LOAD_ORDER, InMemoryConfigStore, type CliPluginContext, type CliPluginEntry, type CliServerPluginRecord } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult, type CliServerOptions } from '../create-cli-server';
import { runCommand } from './command-test-helpers';
import { ROOT_PASS } from './users-test-helpers';
import { expectedQodalisBlock } from '../../scripts/sync-plugin-config';
import * as usersEntry from '../../plugins/users/plugin';
import * as usersPostgresEntry from '../../plugins/users-postgres/plugin';
import * as databasesEntry from '../../plugins/databases/plugin';
import * as filesystemSqliteEntry from '../../plugins/filesystem-sqlite/plugin';
import * as publicApiEntry from '../../plugins/public-api/plugin';
import * as portalEntry from '../../plugins/portal/plugin';
import * as docsEntry from '../../plugins/docs/plugin';
import * as dataExplorerEntry from '../../plugins/data-explorer/plugin';
import * as configRedisEntry from '../../plugins/config-redis/plugin';
import * as weatherEntry from '../../plugins/weather/plugin';
import { REDIS_CONFIG_WRITE_SCRIPT, type CliRedisConfigClient } from '@qodalis/cli-server-plugin-config-redis';

const ROOT = resolve(__dirname, '..', '..');
const SITE = join(__dirname, 'fixtures', 'portal-site');
const DOCS = join(__dirname, 'fixtures', 'docs');
const V1 = '/api/v1/qcli';

const dirs: string[] = [];
const servers: CliServerResult[] = [];
afterEach(async () => {
    for (const s of servers.splice(0)) {
        s.eventSocketManager.dispose();
        s.logSocketManager.dispose();
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A data directory inside the repository, so packages installed there resolve their drivers (pg) from its node_modules. */
function dataDir(): string {
    const base = join(ROOT, 'node_modules', '.cache');
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'qcli-install-paths-'));
    dirs.push(dir);
    return dir;
}

async function start(dir: string, options: CliServerOptions = {}): Promise<CliServerResult> {
    const cli = createCliServer({ dataDir: dir, allowAnonymousAdmin: true, ...options });
    servers.push(cli);
    await cli.serverPlugins.ready();
    return cli;
}

const login = async (cli: CliServerResult, password = ROOT_PASS) =>
    (await request(cli.app).post(`${V1}/sessions`).send({ username: 'root', password })).body.token as string;

/** The config service as the API and the dashboard read it (an admin caller). */
const ADMIN = { hasPermission: () => true, via: 'api' as const };
const providerView = (cli: CliServerResult, provider: string) => cli.config.get(provider, ADMIN);
const entryOf = async (cli: CliServerResult, provider: string, key: string) =>
    (await providerView(cli, provider)).sections.flatMap((s) => s.entries).find((e) => e.key === key);

/** Redis in memory: HGETALL and the store's write script. */
class FakeRedis implements CliRedisConfigClient {
    readonly hashes = new Map<string, Map<string, string>>();
    readonly options = { host: 'cache', port: 6379, db: 0 };
    async hgetall(key: string): Promise<Record<string, string>> {
        return Object.fromEntries(this.hashes.get(key) ?? []);
    }
    async eval(script: string, _keys: number, ...args: Array<string | number>): Promise<unknown> {
        expect(script).toBe(REDIS_CONFIG_WRITE_SCRIPT);
        const [key, expected, values, updatedAt] = args.map(String);
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        const current = Number(hash.get('version') ?? '0');
        if (current !== Number(expected) && Number(expected) >= 0) return [0, current];
        hash.set('version', String(current + 1));
        hash.set('values', values);
        hash.set('updatedAt', updatedAt);
        this.hashes.set(key, hash);
        return [1, current + 1];
    }
    async quit(): Promise<void> {}
}

describe('every official plugin installs from its entry point with settings', () => {
    it('users: the sign-in from its settings, protecting the very first request; its root password a secret', async () => {
        const dir = dataDir();
        const cli = createCliServer({ dataDir: dir, configure: (b) => b.addPlugin(usersEntry, { defaultAdminPassword: ROOT_PASS }) });
        servers.push(cli);
        // not awaited: the request waits for the users plugin, then is refused
        expect((await request(cli.app).get(`${V1}/commands`)).status).toBe(401);
        expect(cli.serverPlugins.states()).toEqual([
            { name: 'users', package: '@qodalis/cli-server-plugin-users', version: '0.0.0', status: 'loaded', source: 'code', order: CLI_PLUGIN_LOAD_ORDER.AUTH, settings: 'users-plugin' },
        ]);
        const token = await login(cli);
        expect(token).toBeTruthy();
        const view = await providerView(cli, 'users-plugin');
        const password = view.sections[0].entries.find((e) => e.key === 'defaultAdminPassword');
        expect(password).toMatchObject({ value: null, default: null, sensitive: true, isSet: true, source: 'code', origin: 'code' });
        expect(JSON.stringify(view)).not.toContain(ROOT_PASS);
        expect(cli.builder.installedPlugins.find((p) => p.id === '@qodalis/cli-server-plugin-users')).toMatchObject({ source: 'code', settings: 'users-plugin' });
    });

    it('users-postgres: needs-configuration without a connection string, the users plugin then on memory stores', async () => {
        const dir = dataDir();
        const cli = await start(dir, {
            configure: (b) => b.addPlugin(usersEntry, { defaultAdminPassword: ROOT_PASS }).addPlugin(usersPostgresEntry),
        });
        // users-postgres first (order 5), though added second
        expect(cli.serverPlugins.states().map((s) => [s.name, s.status, s.missing])).toEqual([
            ['users-postgres', 'needs-configuration', ['settings.connectionString']],
            ['users', 'loaded', undefined],
        ]);
        expect(cli.builder.pluginServices.has('users.stores')).toBe(false);
        expect(await login(cli)).toBeTruthy();
        expect(cli.builder.installedPlugins.find((p) => p.id === '@qodalis/cli-server-plugin-users-postgres')).toMatchObject({ status: 'needs-configuration', missing: ['settings.connectionString'] });
    });

    it.skipIf(!process.env.QCLI_TEST_POSTGRES)('users-postgres with a connection string: the users plugin on its stores', async () => {
        const dir = dataDir();
        const cli = await start(dir, {
            configure: (b) => b.addPlugin(usersEntry, { defaultAdminPassword: ROOT_PASS }).addPlugin(usersPostgresEntry, { connectionString: process.env.QCLI_TEST_POSTGRES, tablePrefix: 'QpathsT' }),
        });
        expect(cli.serverPlugins.states().map((s) => s.status)).toEqual(['loaded', 'loaded']);
        expect(cli.builder.pluginServices.has('users.stores')).toBe(true);
        expect(await login(cli)).toBeTruthy();
        await (cli.builder.pluginServices.get<{ close(): Promise<void> }>('users.stores'))!.close();
    });

    it('databases: a SQLite database from its settings, shared as the databases service', async () => {
        const dir = dataDir();
        const cli = await start(dir, { configure: (b) => b.addPlugin(databasesEntry, { dialect: 'sqlite', connectionString: ':memory:', name: 'local' }) });
        expect(cli.serverPlugins.states()[0]).toMatchObject({ name: 'databases', status: 'loaded', order: CLI_PLUGIN_LOAD_ORDER.CORE });
        const res = await request(cli.app).get(`${V1}/databases`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).toContain('local');
        expect(cli.builder.pluginServices.has('databases')).toBe(true);
    });

    it('filesystem-sqlite: the filesystem API on its database file', async () => {
        const dir = dataDir();
        const cli = await start(dir, { configure: (b) => b.addPlugin(filesystemSqliteEntry) });
        expect(cli.serverPlugins.states()[0]).toMatchObject({ status: 'loaded' });
        expect((await request(cli.app).post('/api/qcli/fs/mkdir').send({ path: '/docs' })).status).toBe(200);
        expect((await request(cli.app).get('/api/qcli/fs/ls').query({ path: '/' })).body.entries.map((e: { name: string }) => e.name)).toEqual(['docs']);
        expect(existsSync(join(dir, 'plugin-data', 'filesystem-sqlite', 'files.db'))).toBe(true);
    });

    it('public-api: needs the users plugin; with it, its document at the path from its settings and the quota', async () => {
        const alone = await start(dataDir(), { configure: (b) => b.addPlugin(publicApiEntry) });
        expect(alone.serverPlugins.states()[0]).toMatchObject({ status: 'needs-configuration', missing: ['the users plugin (install users, or add it before public-api)'] });

        const cli = await start(dataDir(), {
            configure: (b) =>
                b
                    .addPlugin(publicApiEntry, { basePath: '/reference', title: 'Rates API', requestsPerDay: 100 })
                    .addPlugin(usersEntry, { defaultAdminPassword: ROOT_PASS }),
        });
        expect(cli.serverPlugins.states().map((s) => [s.name, s.status])).toEqual([
            ['users', 'loaded'],
            ['public-api', 'loaded'],
        ]);
        expect((await request(cli.app).get('/reference/openapi.json')).status).toBe(200);
        expect(cli.builder.pluginServices.has('public-api')).toBe(true);
    });

    it('portal: after the docs it shows (loaded later though added first); needs-configuration without docs or public-api', async () => {
        const alone = await start(dataDir(), { configure: (b) => b.addPlugin(portalEntry, { siteDir: SITE }) });
        expect(alone.serverPlugins.states()[0]).toMatchObject({ status: 'needs-configuration' });

        const cli = await start(dataDir(), {
            configure: (b) => b.addPlugin(portalEntry, { siteDir: SITE, name: 'Guides', path: '/portal' }).addPlugin(docsEntry, { folder: DOCS }),
        });
        expect(cli.serverPlugins.states().map((s) => [s.name, s.status])).toEqual([
            ['docs', 'loaded'],
            ['portal', 'loaded'],
        ]);
        const json = await request(cli.app).get('/portal/portal.json');
        expect(json.status).toBe(200);
        expect(json.body).toMatchObject({ name: 'Guides' });
        expect(json.body.docs).toMatchObject({ pages: '/qcli/docs/pages' });
        expect(json.body.api).toBeNull();
    });

    it('data explorer: its rules apply to the sources loaded after it', async () => {
        const source: CliPluginEntry = {
            plugin: { id: 'mem-source', package: '@acme/mem-source' },
            order: CLI_PLUGIN_LOAD_ORDER.SOURCE,
            createPlugin: (context: CliPluginContext) => {
                context.builder.addDataExplorerProvider({ executeAsync: async () => ({}) as never }, { name: 'mem', description: 'm', language: 'sql' as never, defaultOutputFormat: 'table' as never, readOnly: false, maxRows: 5000 });
            },
        };
        const cli = await start(dataDir(), {
            configure: (b) => b.addPlugin(source).addPlugin(dataExplorerEntry, { forceReadOnly: true, maxRows: 100, rateLimitQueries: 10 }),
        });
        expect(cli.serverPlugins.states().map((s) => s.name)).toEqual(['data-explorer', 'mem-source']);
        const options = cli.builder.dataExplorerBuilder!.registry.get('mem')!.options;
        expect(options).toMatchObject({ readOnly: true, maxRows: 100, rateLimit: { maxQueries: 10, windowSeconds: 60 } });
    });

    it('data explorer without a source: its API answers (no sources), not a 404 that reads as "plugin not installed"', async () => {
        const cli = await start(dataDir(), { configure: (b) => b.addPlugin(dataExplorerEntry) });
        expect(cli.serverPlugins.states().map((s) => [s.name, s.status])).toEqual([['data-explorer', 'loaded']]);
        const sources = await request(cli.app).get('/api/qcli/data-explorer/sources');
        expect(sources.status).toBe(200);
        expect(sources.body).toEqual([]);
        // The page's extension is listed too (served by the server when the dashboard plugin is not installed)
        expect(cli.builder.dataExplorerBuilder).toBeDefined();
    });

    it('the data explorer and filesystem pages installed from the marketplace: the server\'s own copies are not registered again', async () => {
        const moduleDir = join(dataDir(), 'module');
        mkdirSync(moduleDir, { recursive: true });
        writeFileSync(join(moduleDir, 'extension.js'), 'export default {};');
        const marketplacePage = (id: string) => ({ id, title: id, entry: `/qcli/admin/marketplace/${id}/extension.js` });
        const cli = await start(dataDir(), {
            configure: (b) =>
                b
                    .setDashboardModuleDir('data-explorer', moduleDir)
                    .setDashboardModuleDir('filesystem', moduleDir)
                    .addDashboardExtension(marketplacePage('data-explorer'))
                    .addDashboardExtension(marketplacePage('filesystem'))
                    .addPlugin(dataExplorerEntry)
                    .addPlugin(filesystemSqliteEntry, { path: join(dataDir(), 'files.db') }),
        });
        expect(cli.serverPlugins.states().map((s) => [s.name, s.status])).toEqual([
            ['data-explorer', 'loaded'],
            ['filesystem-sqlite', 'loaded'],
        ]);
        expect(cli.builder.dashboardExtensions.filter((e) => e.id === 'data-explorer' || e.id === 'filesystem').map((e) => e.entry)).toEqual([
            '/qcli/admin/marketplace/data-explorer/extension.js',
            '/qcli/admin/marketplace/filesystem/extension.js',
        ]);
        expect((await request(cli.app).get('/api/qcli/data-explorer/sources')).status).toBe(200);
        expect((await request(cli.app).get('/api/qcli/fs/ls?path=/')).status).not.toBe(404);
    });

    it('without the data explorer plugin or a source, its API is missing (the dashboard page says so)', async () => {
        const cli = await start(dataDir());
        expect((await request(cli.app).get('/api/qcli/data-explorer/sources')).status).toBe(404);
    });

    it('config-redis: Redis becomes the default store; the providers registered before it move there', async () => {
        const redis = new FakeRedis();
        const cli = await start(dataDir(), { configure: (b) => b.addPlugin(configRedisEntry, { client: redis }) });
        expect(cli.serverPlugins.states()[0]).toMatchObject({ name: 'config-redis', status: 'loaded', order: CLI_PLUGIN_LOAD_ORDER.CONFIG_STORE });
        expect(cli.builder.configRegistry.defaultStore.source).toBe('database');
        expect((await runCommand(cli, 'config set custom.custom.motd hello')).status).toBe(200);
        expect([...redis.hashes.keys()]).toContain('qcli:config:custom:custom');
        // its own settings are not in Redis
        expect([...redis.hashes.keys()].some((k) => k.includes('config-redis'))).toBe(false);

        const none = await start(dataDir(), { configure: (b) => b.addPlugin(configRedisEntry) });
        expect(none.serverPlugins.states()[0]).toMatchObject({ status: 'needs-configuration', missing: ['settings.url'] });
        expect(none.builder.configRegistry.defaultStore.source).toBe('runtime');
    });
});

describe('needs-configuration, then the setting saved and a restart', () => {
    it('databases from code: needs-configuration, startup goes on; the saved connection runs it after the restart', async () => {
        const dir = dataDir();
        const first = await start(dir, { configure: (b) => b.addPlugin(databasesEntry, { dialect: 'sqlite' }) });
        expect(first.serverPlugins.states()[0]).toMatchObject({ status: 'needs-configuration', missing: ['settings.connectionString'] });
        expect((await request(first.app).get('/api/qcli/versions')).status).toBe(200);
        expect((await request(first.app).get(`${V1}/databases`)).status).not.toBe(200);
        const set = await runCommand(first, 'config set databases.settings.connectionString app.db');
        expect(set.status).toBe(200);
        expect(set.text).toContain('Restart the server');
        expect(first.restart.status().pending.map((p) => p.id)).toContain('config:databases.settings.connectionString');
        // the secret is kept in the plugins' settings file (the server keeps its own settings in memory), never returned
        expect(existsSync(join(dir, 'plugin-settings.json'))).toBe(true);
        expect((await entryOf(first, 'databases', 'connectionString'))).toMatchObject({ value: null, isSet: true, origin: 'setting' });

        const second = await start(dir, { configure: (b) => b.addPlugin(databasesEntry, { dialect: 'sqlite' }) });
        expect(second.serverPlugins.states()[0]).toMatchObject({ status: 'loaded' });
        expect((await request(second.app).get(`${V1}/databases`)).status).toBe(200);
        expect(existsSync(join(dir, 'plugin-data', 'databases', 'app.db'))).toBe(true);
    });

    it('a package installed from the marketplace: needs-configuration in installed.json and the installed list, then loaded', async () => {
        const dir = dataDir();
        const pkgDir = join(ROOT, 'plugins', 'users-postgres');
        const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
        const target = join(dir, 'server-plugins', 'node_modules', '@qodalis', 'cli-server-plugin-users-postgres');
        mkdirSync(target, { recursive: true });
        for (const f of ['package.json', 'dist']) cpSync(join(pkgDir, f), join(target, f), { recursive: true });
        const record: CliServerPluginRecord = {
            name: 'users-postgres',
            package: '@qodalis/cli-server-plugin-users-postgres',
            version,
            integrity: 'sha512-test',
            installedAt: '2026-11-25T10:00:00.000Z',
            installedBy: 'admin',
        };
        writeFileSync(join(dir, 'server-plugins', 'installed.json'), JSON.stringify({ plugins: [record] }));
        const cli = await start(dir);
        expect(cli.serverPlugins.states()[0]).toMatchObject({ name: 'users-postgres', status: 'needs-configuration', source: 'marketplace', order: 5, missing: ['settings.connectionString'] });
        const listed = JSON.parse(readFileSync(join(dir, 'server-plugins', 'installed.json'), 'utf8')).plugins[0];
        expect(listed).toMatchObject({ status: 'needs-configuration', missing: ['settings.connectionString'], settings: 'users-postgres' });
        expect(listed.error).toBeUndefined();
        expect(cli.builder.installedPlugins.find((p) => p.id === record.package)).toMatchObject({ source: 'marketplace', status: 'needs-configuration' });
        // its settings, shown like any other; the connection string a secret
        expect(await entryOf(cli, 'users-postgres', 'connectionString')).toMatchObject({ type: 'secret', required: true, value: null, isSet: false, origin: 'default' });
    });
});

describe('load order', () => {
    it('code and installed plugins sorted together by order; code first on a tie; the auth plugins before requests', async () => {
        const dir = dataDir();
        const calls: string[] = [];
        const entry = (id: string, order?: number): CliPluginEntry => ({
            plugin: { id, package: `@acme/${id}` },
            ...(order !== undefined ? { order } : {}),
            createPlugin: async () => {
                calls.push(id);
            },
        });
        const pkg = join(dir, 'server-plugins', 'node_modules', '@acme', 'installed');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@acme/installed', version: '1.0.0', qodalis: { kind: 'server', entry: './p.js', order: 30 } }));
        writeFileSync(join(pkg, 'p.js'), `exports.createPlugin = () => { globalThis.__qcliOrder.push('installed'); };`);
        writeFileSync(join(dir, 'server-plugins', 'installed.json'), JSON.stringify({ plugins: [{ name: 'installed', package: '@acme/installed', version: '1.0.0', integrity: 'sha512-x', installedAt: '', installedBy: '' }] }));
        (globalThis as { __qcliOrder?: string[] }).__qcliOrder = calls;
        const cli = await start(dir, {
            configure: (b) => b.addPlugin(entry('source', 70)).addPlugin(entry('plain')).addPlugin(entry('core', 30)).addPlugin(entry('store', 20)).addPlugin(entry('auth', 10)),
        });
        expect(calls).toEqual(['auth', 'store', 'core', 'installed', 'plain', 'source']);
        expect(cli.serverPlugins.states().map((s) => [s.name, s.order, s.source])).toEqual([
            ['auth', 10, 'code'],
            ['store', 20, 'code'],
            ['core', 30, 'code'],
            ['installed', 30, 'marketplace'],
            ['plain', 50, 'code'],
            ['source', 70, 'code'],
        ]);
        expect(CLI_PLUGIN_LOAD_ORDER).toEqual({ AUTH: 10, CONFIG_STORE: 20, CORE: 30, DEFAULT: 50, SOURCE: 70 });
        delete (globalThis as { __qcliOrder?: string[] }).__qcliOrder;
    });

    it('a CONFIG_STORE plugin moves the settings of the AUTH plugin loaded before it', async () => {
        const redis = new FakeRedis();
        redis.hashes.set('qcli:config:users-plugin:settings', new Map([['version', '1'], ['values', JSON.stringify({ allowNonExpiringTokens: true })], ['updatedAt', '']]));
        const cli = await start(dataDir(), { configure: (b) => b.addPlugin(configRedisEntry, { client: redis }).addPlugin(usersEntry, { defaultAdminPassword: ROOT_PASS }) });
        expect(cli.serverPlugins.states().map((s) => s.name)).toEqual(['users', 'config-redis']);
        expect(cli.builder.configRegistry.storeOf('users-plugin')).toBe(cli.builder.configRegistry.defaultStore);
        const provider = cli.builder.configProviders.find((p) => p.id === 'users-plugin') as unknown as { value(s: string, k: string): unknown; ready(): Promise<void> };
        await provider.ready();
        expect(provider.value('settings', 'allowNonExpiringTokens')).toBe(true);
    });

    it('a CONFIG_STORE plugin that needs configuration: the settings parked before it go to the plugins\' settings file', async () => {
        const cli = await start(dataDir(), { configure: (b) => b.addPlugin(configRedisEntry).addPlugin(usersEntry, { defaultAdminPassword: ROOT_PASS }) });
        expect(cli.serverPlugins.states().map((s) => [s.name, s.status])).toEqual([
            ['users', 'loaded'],
            ['config-redis', 'needs-configuration'],
        ]);
        expect(cli.builder.configRegistry.storeOf('users-plugin')?.source).toBe('file');
    });

    it("config-redis keeps its settings in the server's plugin-settings.json store: no plugin's write is lost", async () => {
        const dir = dataDir();
        const cli = await start(dir, { configure: (b) => b.addPlugin(configRedisEntry).addPlugin(weatherEntry as never) });
        expect(cli.serverPlugins.states().map((s) => [s.name, s.status])).toEqual([
            ['config-redis', 'needs-configuration'],
            ['weather', 'loaded'],
        ]);
        const registry = cli.builder.configRegistry;
        // One store of the file: the loader's
        expect(registry.storeOf('config-redis')).toBe(registry.storeOf('weather'));
        await cli.config.update('weather', 'settings', { changes: { defaultLocation: 'Paris' } }, ADMIN);
        await cli.config.update('config-redis', 'settings', { changes: { keyPrefix: 'acme:' } }, ADMIN);
        await cli.config.update('weather', 'settings', { changes: { defaultLocation: 'Oslo' } }, ADMIN);
        await cli.config.update('config-redis', 'settings', { changes: { ttlSeconds: 60 } }, ADMIN);
        const file = readFileSync(join(dir, 'plugin-settings.json'), 'utf8');
        expect(file).toContain('Oslo');
        expect(file).toContain('acme:');
        expect(file).toContain('60');

        // Both kept across a restart
        const next = await start(dir, { configure: (b) => b.addPlugin(configRedisEntry).addPlugin(weatherEntry as never) });
        const value = async (provider: string, key: string) => (await providerView(next, provider)).sections[0].entries.find((e) => e.key === key)?.value;
        expect(await value('weather', 'defaultLocation')).toBe('Oslo');
        expect(await value('config-redis', 'keyPrefix')).toBe('acme:');
        expect(await value('config-redis', 'ttlSeconds')).toBe(60);
    });

    it('addPlugin refuses an entry without createPlugin or plugin info, twice the same package, or once loading started', async () => {
        const cli = createCliServer({ dataDir: dataDir() });
        servers.push(cli);
        expect(() => cli.builder.addPlugin({} as never)).toThrow('exports no createPlugin');
        expect(() => cli.builder.addPlugin({ createPlugin: () => undefined })).toThrow('exports no plugin');
        cli.builder.addPlugin({ plugin: { id: 'a', package: '@acme/a' }, createPlugin: () => undefined });
        expect(() => cli.builder.addPlugin({ plugin: { id: 'a', package: '@acme/a' }, createPlugin: () => undefined })).toThrow('added twice');
        await cli.serverPlugins.ready();
        expect(() => cli.builder.addPlugin({ plugin: { id: 'b', package: '@acme/b' }, createPlugin: () => undefined })).toThrow('already loading');
    });

    it('a code plugin that throws is failed, listed nowhere, and startup goes on', async () => {
        const cli = await start(dataDir(), {
            configure: (b) => b.addPlugin({ plugin: { id: 'boom', package: '@acme/boom' }, createPlugin: () => Promise.reject(new Error('no luck')) }),
        });
        expect(cli.serverPlugins.states()).toEqual([{ name: 'boom', package: '@acme/boom', version: '0.0.0', status: 'failed', error: 'no luck', source: 'code', order: 50 }]);
        expect(cli.builder.installedPlugins.some((p) => p.id === '@acme/boom')).toBe(false);
        expect((await request(cli.app).get('/api/qcli/versions')).status).toBe(200);
    });
});

describe('a code-added plugin: the same settings as from the dashboard', () => {
    it('shown and editable; code options are the defaults, a saved setting wins after the restart; origin and source reported; secrets hidden', async () => {
        const dir = dataDir();
        const store = new InMemoryConfigStore();
        const options = { defaultAdminPassword: ROOT_PASS, protectServer: false, linkApprovalUrl: '/approve' };
        const cli = await start(dir, { config: { store }, configure: (b) => b.addPlugin(usersEntry, options) });
        const view = await providerView(cli, 'users-plugin');
        const entries = Object.fromEntries(view.sections[0].entries.map((e) => [e.key, e]));
        expect(entries.protectServer).toMatchObject({ value: false, default: false, source: 'code', origin: 'code', mutable: true, requiresRestart: true });
        expect(entries.linkApprovalUrl).toMatchObject({ value: '/approve', origin: 'code' });
        expect(entries.allowNonExpiringTokens).toMatchObject({ value: false, source: 'default', origin: 'default' });
        expect(entries.defaultAdminPassword).toMatchObject({ value: null, default: null, isSet: true, sensitive: true, origin: 'code' });
        expect(JSON.stringify(view)).not.toContain(ROOT_PASS);
        expect((await runCommand(cli, 'config get users-plugin.settings.protectServer')).text).toContain('Origin        code');
        // open server: the code said so
        expect((await request(cli.app).get(`${V1}/commands`)).status).toBe(200);

        // edited like any setting (API, config set, the dashboard): restart required (the dashboard's banner)
        const update = await cli.config.update('users-plugin', 'settings', { changes: { protectServer: true } }, ADMIN);
        expect(update.requiresRestart).toBe(true);
        expect(cli.restart.status().pending.map((p) => p.id)).toContain('config:users-plugin.settings.protectServer');
        expect(await entryOf(cli, 'users-plugin', 'protectServer')).toMatchObject({ value: true, default: false, origin: 'setting', source: 'runtime' });

        // the restart: the saved setting wins over the code's option
        const after = await start(dir, { config: { store }, configure: (b) => b.addPlugin(usersEntry, options) });
        expect((await request(after.app).get(`${V1}/commands`)).status).toBe(401);
        expect(await login(after)).toBeTruthy();
        expect(await entryOf(after, 'users-plugin', 'protectServer')).toMatchObject({ value: true, origin: 'setting' });
        // a secret saved over the code's: still never returned
        await after.config.update('users-plugin', 'settings', { changes: { defaultAdminPassword: 'other-pass-1' } }, ADMIN);
        const secret = await entryOf(after, 'users-plugin', 'defaultAdminPassword');
        expect(secret).toMatchObject({ value: null, default: null, isSet: true, origin: 'setting' });
        expect(JSON.stringify(await providerView(after, 'users-plugin'))).not.toContain('other-pass-1');
    });

    it('options that are not settings (a client, a function) are read by the entry, never shown', async () => {
        const redis = new FakeRedis();
        const cli = await start(dataDir(), { configure: (b) => b.addPlugin(configRedisEntry, { client: redis, keyPrefix: 'app:' }) });
        const entries = (await providerView(cli, 'config-redis')).sections[0].entries;
        expect(entries.map((e) => e.key)).toEqual(['url', 'keyPrefix', 'ttlSeconds']);
        expect(entries[1]).toMatchObject({ value: 'app:', origin: 'code' });
        expect(cli.builder.configRegistry.defaultStore).toMatchObject({ keyPrefix: 'app:' });
    });
});

describe('package.json qodalis blocks', () => {
    const plugins = readdirSync(join(ROOT, 'plugins')).filter((p) => existsSync(join(ROOT, 'plugins', p, 'package.json')));

    it('every plugin but admin has an entry, no autoInstall false, and its qodalis.config written from the entry (npm run sync:plugin-config)', async () => {
        for (const name of plugins) {
            const pkg = JSON.parse(readFileSync(join(ROOT, 'plugins', name, 'package.json'), 'utf8'));
            if (name === 'admin') {
                expect(pkg.qodalis).toMatchObject({ kind: 'server', autoInstall: false });
                expect(pkg.qodalis.autoInstallReason).toContain('dashboard');
                continue;
            }
            const file = ['plugin.ts', 'src/plugin.ts'].map((f) => join(ROOT, 'plugins', name, f)).find(existsSync);
            expect(file, `${name} has an entry`).toBeDefined();
            const entry = await import(file!);
            expect(pkg.qodalis.entry, name).toBe('./dist/plugin.js');
            expect(pkg.qodalis.autoInstall, name).toBeUndefined();
            expect(entry.plugin, name).toMatchObject({ id: pkg.qodalis.plugin, package: pkg.name });
            expect(pkg.qodalis, `${name}: run npm run sync:plugin-config`).toEqual(expectedQodalisBlock(pkg.qodalis, entry));
        }
    });

    it('needsConfiguration for plugins with a required setting without default (users-postgres, config-redis, data explorer sources)', () => {
        const flag = (name: string) => JSON.parse(readFileSync(join(ROOT, 'plugins', name, 'package.json'), 'utf8')).qodalis.config?.needsConfiguration === true;
        for (const name of ['users-postgres', 'config-redis', 'databases', 'data-explorer-postgres', 'filesystem-s3']) expect(flag(name), name).toBe(true);
        for (const name of ['users', 'weather', 'docs', 'data-explorer', 'filesystem-sqlite']) expect(flag(name), name).toBe(false);
        const pg = JSON.parse(readFileSync(join(ROOT, 'plugins', 'users-postgres', 'package.json'), 'utf8')).qodalis.config.entries[0];
        expect(pg).toEqual(expect.objectContaining({ key: 'connectionString', type: 'secret', default: null, required: true, sensitive: true }));
    });

    it('the admin plugin is still refused when installed at runtime', async () => {
        const dir = dataDir();
        const admin = JSON.parse(readFileSync(join(ROOT, 'plugins', 'admin', 'package.json'), 'utf8'));
        const target = join(dir, 'server-plugins', 'node_modules', '@qodalis', 'cli-server-plugin-admin');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'package.json'), JSON.stringify({ name: admin.name, version: admin.version, qodalis: admin.qodalis }));
        writeFileSync(join(dir, 'server-plugins', 'installed.json'), JSON.stringify({ plugins: [{ name: 'admin', package: admin.name, version: admin.version, integrity: 'sha512-x', installedAt: '', installedBy: '' }] }));
        const cli = await start(dir);
        expect(cli.serverPlugins.states()[0]).toMatchObject({ name: 'admin', status: 'failed' });
        expect(cli.serverPlugins.states()[0].error).toContain('needs setup in code');
    });
});
