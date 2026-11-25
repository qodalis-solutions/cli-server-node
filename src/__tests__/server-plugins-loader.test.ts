/**
 * The loader of server plugins installed at runtime: the entry contract (qodalis block, entry path), a real package
 * from a fixture directory loaded from <dataDir>/server-plugins/node_modules with the server's own abstractions,
 * settings from its config provider (defaults and stored values), mounting, failures isolated and kept in
 * installed.json, a package the host installed skipped, serverPlugins: false, and official plugins' entries
 * (filesystem read-only from settings, weather's settings) through the loader.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { InMemoryConfigStore, type CliServerPluginRecord } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult, type CliServerOptions } from '../create-cli-server';
import { serverPluginEntryPath, serverPluginManifestOf, isValidServerPluginName } from '../server-plugins';
import { runCommand } from './command-test-helpers';

const FIXTURE = resolve(__dirname, 'fixtures', 'server-plugin-hello');
const HELLO = '@acme/cli-server-plugin-hello';
const ROOT = resolve(__dirname, '..', '..');

const dirs: string[] = [];
const servers: CliServerResult[] = [];
afterEach(() => {
    for (const s of servers.splice(0)) {
        s.eventSocketManager.dispose();
        s.logSocketManager.dispose();
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'qcli-loader-'));
    dirs.push(dir);
    return dir;
}

const record = (name: string, pkg: string, version: string): CliServerPluginRecord => ({
    name,
    package: pkg,
    version,
    integrity: 'sha512-test',
    title: name[0].toUpperCase() + name.slice(1),
    installedAt: '2026-11-25T10:00:00.000Z',
    installedBy: 'admin',
});

/** Copies a package directory into `<dataDir>/server-plugins/node_modules/<name>`. */
function install(dir: string, name: string, from: string, only?: string[]): void {
    const target = join(dir, 'server-plugins', 'node_modules', name);
    mkdirSync(target, { recursive: true });
    for (const entry of only ?? ['.']) cpSync(join(from, entry), join(target, entry === '.' ? '' : entry), { recursive: true });
}

/** A package written in place: its package.json and files. */
function writePackage(dir: string, name: string, pkg: Record<string, unknown>, files: Record<string, string>): void {
    const root = join(dir, 'server-plugins', 'node_modules', name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, ...pkg }));
    for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), body);
    }
}

function list(dir: string, records: CliServerPluginRecord[]): void {
    mkdirSync(join(dir, 'server-plugins'), { recursive: true });
    writeFileSync(join(dir, 'server-plugins', 'installed.json'), JSON.stringify({ plugins: records }));
}

const listed = (dir: string): CliServerPluginRecord[] => JSON.parse(readFileSync(join(dir, 'server-plugins', 'installed.json'), 'utf8')).plugins;

async function start(dir: string, options: CliServerOptions = {}): Promise<CliServerResult> {
    const cli = createCliServer({ dataDir: dir, ...options });
    servers.push(cli);
    await cli.serverPlugins.ready();
    return cli;
}

describe('server plugins: the entry contract', () => {
    it('reads the qodalis block of a server plugin only', () => {
        expect(serverPluginManifestOf({ qodalis: { kind: 'server', entry: './dist/plugin.js' } })).toEqual({ kind: 'server', entry: './dist/plugin.js' });
        expect(serverPluginManifestOf({ qodalis: { kind: 'dashboard' } })).toBeUndefined();
        expect(serverPluginManifestOf({})).toBeUndefined();
        expect(serverPluginManifestOf(undefined)).toBeUndefined();
    });

    it('keeps the entry inside its package: relative, no .., a .js or .cjs file', () => {
        expect(serverPluginEntryPath('/p/pkg', './dist/plugin.js')).toBe(resolve('/p/pkg/dist/plugin.js'));
        expect(serverPluginEntryPath('/p/pkg', 'lib/x.cjs')).toBe(resolve('/p/pkg/lib/x.cjs'));
        expect(() => serverPluginEntryPath('/p/pkg', undefined)).toThrow('declares no qodalis.entry');
        expect(() => serverPluginEntryPath('/p/pkg', '../other/plugin.js')).toThrow('invalid qodalis.entry');
        expect(() => serverPluginEntryPath('/p/pkg', './a/../../b.js')).toThrow('invalid qodalis.entry');
        expect(() => serverPluginEntryPath('/p/pkg', '/etc/plugin.js')).toThrow('invalid qodalis.entry');
        expect(() => serverPluginEntryPath('/p/pkg', './plugin.mjs')).toThrow('must be a .js or .cjs file');
        expect(isValidServerPluginName('jobs')).toBe(true);
        expect(isValidServerPluginName('@acme/x')).toBe(true);
        expect(isValidServerPluginName('../x')).toBe(false);
    });
});

describe('server plugins: loading', () => {
    it('loads a real package from its directory: settings, its module and routes, the server abstractions, listed as marketplace', async () => {
        const dir = dataDir();
        install(dir, HELLO, FIXTURE);
        // A copy of the abstractions next to it (as npm would install a dependency) must not be used
        writePackage(dir, '@qodalis/cli-server-abstractions', { version: '0.0.1', main: 'index.js' }, { 'index.js': 'exports.DECOY = true;' });
        list(dir, [record('hello', HELLO, '1.2.0')]);
        const store = new InMemoryConfigStore();
        await store.write('hello', 'settings', { greeting: 'Salut' });
        const cli = await start(dir, { config: { store } });

        expect(cli.serverPlugins.states()).toEqual([{ name: 'hello', package: HELLO, version: '1.2.0', status: 'loaded' }]);
        // the stored setting over its default; the other default
        expect((await runCommand(cli, 'hello Ana')).text).toBe('Salut, Ana!');
        const res = await request(cli.app).get('/api/v1/qcli/hello');
        expect(res.body).toEqual({ greeting: 'Salut', dataDir: join(resolve(dir), 'plugin-data', 'hello') });
        expect(existsSync(join(dir, 'plugin-data', 'hello'))).toBe(true);
        // the config provider, edited like any other: the plugin reads it live
        const provider = cli.builder.configProviders.find((p) => p.id === 'hello')!;
        expect(provider.title).toBe('Hello');
        const set = await runCommand(cli, 'config set hello.settings.times 3');
        expect(set.status).toBe(200);
        expect((await runCommand(cli, 'hello')).text).toBe('Salut, world! Salut, world! Salut, world!');
        expect((await runCommand(cli, 'config set hello.settings.times 9')).text).toContain('times');

        expect(cli.builder.installedPlugins).toContainEqual({
            id: HELLO,
            name: 'Hello',
            version: '1.2.0',
            description: 'A tiny server plugin installed at runtime (loader tests)',
            source: 'marketplace',
        });
        // the plugin's require of the abstractions resolved to the server's copy
        const entry = require(join(dir, 'server-plugins', 'node_modules', HELLO, 'lib', 'plugin.js'));
        expect(entry.abstractionsIsHost).toBe(true);
        expect(entry.abstractionsPath).toBe(createRequire(join(ROOT, 'package.json')).resolve('@qodalis/cli-server-abstractions'));
        expect(entry.lastContext).toMatchObject({ pluginId: 'hello', packageName: HELLO, version: '1.2.0', serverDataDir: resolve(dir) });
        expect(listed(dir)[0].error).toBeUndefined();
    });

    it('a plugin that fails is logged and marked with its error; the others load and the server starts', async () => {
        const dir = dataDir();
        install(dir, HELLO, FIXTURE);
        writePackage(dir, '@acme/throws', { version: '1.0.0', qodalis: { kind: 'server', entry: './p.js' } }, { 'p.js': 'exports.createPlugin = () => { throw new Error("boom at start"); };' });
        writePackage(dir, '@acme/syntax', { version: '1.0.0', qodalis: { kind: 'server', entry: './p.js' } }, { 'p.js': 'exports.createPlugin = ( =>' });
        writePackage(dir, '@acme/nocreate', { version: '1.0.0', qodalis: { kind: 'server', entry: './p.js' } }, { 'p.js': 'exports.other = 1;' });
        writePackage(dir, '@acme/badresult', { version: '1.0.0', qodalis: { kind: 'server', entry: './p.js' } }, { 'p.js': 'exports.createPlugin = async () => 42;' });
        writePackage(dir, '@acme/escape', { version: '1.0.0', qodalis: { kind: 'server', entry: '../hello/p.js' } }, {});
        writePackage(dir, '@acme/manual', { version: '1.0.0', qodalis: { kind: 'server', autoInstall: false, autoInstallReason: 'host wiring' } }, {});
        writePackage(dir, '@acme/web', { version: '1.0.0' }, {});
        writePackage(dir, '@acme/older', { version: '0.9.0', qodalis: { kind: 'server', entry: './p.js' } }, { 'p.js': '' });
        const names: Array<[string, string]> = [
            ['throws', '@acme/throws'],
            ['syntax', '@acme/syntax'],
            ['nocreate', '@acme/nocreate'],
            ['badresult', '@acme/badresult'],
            ['escape', '@acme/escape'],
            ['manual', '@acme/manual'],
            ['web', '@acme/web'],
            ['older', '@acme/older'],
            ['missing', '@acme/missing'],
        ];
        list(dir, [...names.map(([n, p]) => record(n, p, '1.0.0')), record('hello', HELLO, '1.2.0')]);
        const cli = await start(dir);

        const states = Object.fromEntries(cli.serverPlugins.states().map((s) => [s.name, s]));
        expect(states.hello.status).toBe('loaded');
        expect(states.throws).toMatchObject({ status: 'failed', error: 'boom at start' });
        expect(states.syntax.status).toBe('failed');
        expect(states.nocreate.error).toBe('the entry exports no createPlugin(context)');
        expect(states.badresult.error).toBe('createPlugin returned neither a plugin result (prefix, router) nor a module (name, processors)');
        expect(states.escape.error).toBe('invalid qodalis.entry: ../hello/p.js');
        expect(states.manual.error).toBe('needs setup in code: host wiring');
        expect(states.web.error).toBe('not a server plugin (no qodalis.kind "server")');
        expect(states.older.error).toBe('the installed version is 0.9.0, not 1.0.0');
        expect(states.missing.error).toMatch(/^not installed in /);
        // the errors are kept in installed.json, the good one has none
        const errors = Object.fromEntries(listed(dir).map((r) => [r.name, r.error]));
        expect(errors.throws).toBe('boom at start');
        expect(errors.hello).toBeUndefined();
        // failed packages are not listed as installed; the server answers
        const ids = cli.builder.installedPlugins.map((p) => p.id);
        expect(ids).toContain(HELLO);
        expect(ids).not.toContain('@acme/throws');
        expect(ids).not.toContain('@acme/badresult');
        expect((await runCommand(cli, 'hello')).text).toBe('Hello, world!');

        // fixed: the error is cleared at the next start
        writePackage(dir, '@acme/throws', { version: '1.0.0', qodalis: { kind: 'server', entry: './q.js' } }, { 'q.js': 'exports.createPlugin = () => undefined;' });
        await start(dir);
        expect(listed(dir).find((r) => r.name === 'throws')!.error).toBeUndefined();
    });

    it('a package the host installed is skipped; a broken installed.json loads nothing; serverPlugins: false loads nothing', async () => {
        const dir = dataDir();
        install(dir, HELLO, FIXTURE);
        list(dir, [record('hello', HELLO, '1.2.0')]);
        const host = await start(dir, { configure: (b) => b.addInstalledPlugin({ id: HELLO, name: 'Hello (host)' }) });
        expect(host.serverPlugins.states()).toEqual([{ name: 'hello', package: HELLO, version: '1.2.0', status: 'skipped', error: 'already installed by the host' }]);
        expect(host.registry.findProcessor('hello')).toBeUndefined();

        const off = await start(dir, { serverPlugins: false });
        expect(off.serverPlugins.enabled).toBe(false);
        expect(off.serverPlugins.states()).toEqual([]);
        expect(off.registry.findProcessor('hello')).toBeUndefined();

        writeFileSync(join(dir, 'server-plugins', 'installed.json'), '{ not json');
        const broken = await start(dir);
        expect(broken.serverPlugins.records()).toEqual([]);
        expect(broken.serverPlugins.states()).toEqual([]);
        expect((await request(broken.app).get('/api/qcli/versions')).status).toBe(200);
    });

    it('loads after the host mounts: ready() before listening; routes reachable after a catch-all the host adds', async () => {
        const dir = dataDir();
        install(dir, HELLO, FIXTURE);
        list(dir, [record('hello', HELLO, '1.2.0')]);
        const cli = createCliServer({ dataDir: dir });
        servers.push(cli);
        cli.app.use((_req, res) => res.status(404).json({ error: 'host catch-all' }));
        expect(cli.registry.findProcessor('hello')).toBeUndefined();
        await cli.serverPlugins.ready();
        expect((await request(cli.app).get('/api/v1/qcli/hello')).body.greeting).toBe('Hello');
        expect((await request(cli.app).get('/nothing')).body).toEqual({ error: 'host catch-all' });
    });
});

describe('server plugins: official entries through the loader', () => {
    it('filesystem: the folders from its settings, read-only by default, wired after startup', async () => {
        const dir = dataDir();
        mkdirSync(join(dir, 'files'));
        // the real path (macOS: /private/var/...), as the storage compares real paths
        const files = realpathSync(join(dir, 'files'));
        writeFileSync(join(files, 'a.txt'), 'hello');
        install(dir, '@qodalis/cli-server-plugin-filesystem', join(ROOT, 'plugins', 'filesystem'), ['package.json', 'dist']);
        list(dir, [record('filesystem', '@qodalis/cli-server-plugin-filesystem', require(join(ROOT, 'plugins', 'filesystem', 'package.json')).version)]);

        // without folders: loaded, nothing served
        const empty = await start(dir);
        expect(empty.serverPlugins.states()[0].status).toBe('loaded');
        expect(empty.builder.fileStorageProvider).toBeUndefined();

        const store = new InMemoryConfigStore();
        await store.write('filesystem-os', 'settings', { roots: [files] });
        const cli = await start(dir, { config: { store } });
        const ls = await request(cli.app).get('/api/qcli/fs/ls').query({ path: files });
        expect(ls.status).toBe(200);
        expect(ls.body.entries.map((e: { name: string }) => e.name)).toEqual(['a.txt']);
        expect((await request(cli.app).get('/api/qcli/fs/cat').query({ path: join(files, 'a.txt') })).body.content).toBe('hello');
        // writes refused (403, matched across the two copies of the filesystem package)
        const mkdir = await request(cli.app).post('/api/qcli/fs/mkdir').send({ path: join(files, 'new') });
        expect(mkdir.status).toBe(403);
        expect(existsSync(join(files, 'new'))).toBe(false);
        expect((await request(cli.app).get('/api/qcli/fs/ls').query({ path: '/etc' })).status).toBe(403);
        // the server's own filesystem config provider describes it, the plugin's settings are their own provider
        expect(cli.builder.configProviders.map((p) => p.id)).toEqual(expect.arrayContaining(['filesystem', 'filesystem-os']));

        await store.write('filesystem-os', 'settings', { readOnly: false });
        const writable = await start(dir, { config: { store } });
        expect((await request(writable.app).post('/api/qcli/fs/mkdir').send({ path: join(files, 'new') })).status).toBe(200);
        expect(existsSync(join(files, 'new'))).toBe(true);
    });

    it('weather: its default location as a setting', async () => {
        const dir = dataDir();
        install(dir, '@qodalis/cli-server-plugin-weather', join(ROOT, 'plugins', 'weather'), ['package.json', 'dist']);
        list(dir, [record('weather', '@qodalis/cli-server-plugin-weather', require(join(ROOT, 'plugins', 'weather', 'package.json')).version)]);
        const cli = await start(dir);
        expect(cli.serverPlugins.states()[0]).toMatchObject({ name: 'weather', status: 'loaded' });
        expect(cli.registry.findProcessor('weather')).toBeDefined();
        const sections = await cli.builder.configProviders.find((p) => p.id === 'weather')!.getSections();
        expect(sections[0].entries).toEqual([expect.objectContaining({ key: 'defaultLocation', value: 'London', default: 'London' })]);
    });

    it('a data explorer source added at runtime is served (the data explorer wired after startup)', async () => {
        const dir = dataDir();
        writePackage(dir, '@acme/source', { version: '1.0.0', qodalis: { kind: 'server', entry: './p.js' } }, {
            'p.js': `exports.createPlugin = (context) => {
                context.builder.addDataExplorerProvider(
                    { executeAsync: async () => ({ success: true, source: 'mem', language: 'sql', defaultOutputFormat: 'table', executionTime: 1, columns: ['x'], rows: [[1]], rowCount: 1, truncated: false, error: null }) },
                    { name: 'mem', description: 'In memory', language: 'sql', defaultOutputFormat: 'table' },
                );
            };`,
        });
        list(dir, [record('source', '@acme/source', '1.0.0')]);
        const cli = await start(dir);
        expect(cli.serverPlugins.states()[0].status).toBe('loaded');
        const sources = await request(cli.app).get('/api/qcli/data-explorer/sources');
        expect(sources.status).toBe(200);
        expect(sources.body.map((s: { name: string }) => s.name)).toEqual(['mem']);
    });

    it('a data explorer source entry: nothing until configured, then its settings as the source options', async () => {
        const { createPlugin } = await import('../../plugins/data-explorer-postgres/plugin');
        const added: Array<{ provider: unknown; options: Record<string, unknown> }> = [];
        const store = new InMemoryConfigStore();
        const context = (values: Record<string, unknown>) => {
            const providers: Array<{ attachStore(s: InMemoryConfigStore): Promise<void> }> = [];
            return {
                pluginId: 'data-explorer-postgres',
                packageName: '@qodalis/cli-server-plugin-data-explorer-postgres',
                version: '1.0.0',
                logger: { debug() {}, info() {}, warn() {}, error() {} },
                builder: { addDataExplorerProvider: (provider: unknown, options: Record<string, unknown>) => void added.push({ provider, options }) },
                settings: async (options: { settings: unknown[] }) => {
                    const { CliStoredConfigProvider } = await import('@qodalis/cli-server-abstractions');
                    const p = new CliStoredConfigProvider({ id: 'data-explorer-postgres', title: 't', sections: [{ id: 'settings', settings: options.settings as never }] });
                    await store.write('data-explorer-postgres', 'settings', values as never);
                    providers.push(p);
                    await p.attachStore(store);
                    return p;
                },
            } as never;
        };
        await createPlugin(context({}));
        expect(added).toEqual([]);
        await createPlugin(context({ connectionString: 'postgres://u:p@db:5432/app', name: 'app', readOnly: false, maxRows: 50 }));
        expect(added).toHaveLength(1);
        expect(added[0].options).toEqual({ name: 'app', description: 'PostgreSQL database', language: 'sql', defaultOutputFormat: 'table', readOnly: false, timeout: 30000, maxRows: 50 });
    });
});

