import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { rename, rm, writeFile, mkdir } from 'fs/promises';
import { randomBytes } from 'crypto';
import Module, { createRequire } from 'module';
import { isAbsolute, join, resolve, sep } from 'path';
import {
    CLI_SERVER_PLUGIN_KIND,
    CLI_SERVER_PLUGINS_DIR,
    CLI_SERVER_PLUGINS_FILE,
    CliStoredConfigProvider,
    installedPluginName,
    type CliInstalledPlugin,
    type CliPluginContext,
    type CliPluginEntryResult,
    type CliPluginLogger,
    type CliPluginSettingsOptions,
    type CliServerPluginManifest,
    type CliServerPluginRecord,
    type CliServerPluginState,
    type ICliConfigService,
    type ICliEventBus,
    type ICliModule,
    type ICliServerPlugins,
    type ICliServerRestart,
    type CliPluginBuilder,
} from '@qodalis/cli-server-abstractions';
import { createLogger } from '../utils/logger';

/** The server's data directory unless `dataDir` is given: `./qcli-data` (from the working directory). */
export const DEFAULT_DATA_DIR = 'qcli-data';

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** True for a valid npm package name (at most 214 characters). */
export function isValidServerPluginPackage(name: unknown): name is string {
    return typeof name === 'string' && name.length <= 214 && NPM_NAME.test(name);
}

/** True for a marketplace plugin id (`jobs`, `data-explorer-postgres`) or an npm package name. */
export function isValidServerPluginName(name: unknown): name is string {
    return typeof name === 'string' && (PLUGIN_ID.test(name) || isValidServerPluginPackage(name));
}

/** True for a semver version. */
export function isValidServerPluginVersion(version: unknown): version is string {
    return typeof version === 'string' && version.length <= 64 && SEMVER.test(version);
}

/**
 * The packages a runtime-installed plugin shares with the server: `@qodalis/cli-server-abstractions`, the server
 * itself and the official plugins. Required from a plugin's files they resolve to the server's own copy (when it has
 * one), so classes, symbols and singletons are the server's and nothing is loaded twice.
 */
export const SHARED_PACKAGES = /^@qodalis\/cli-server-(?:abstractions|node|plugin-[a-z0-9-]+)(?:\/.*)?$/;

const hostRequire = createRequire(__filename);
const pluginRoots = new Set<string>();
let hookInstalled = false;

type ResolveFilename = (request: string, parent: { filename?: string | null } | undefined, ...rest: unknown[]) => string;

/** Makes `require` of a shared package from a file below `root` resolve to the server's copy. */
function shareHostPackages(root: string): void {
    pluginRoots.add(root.endsWith(sep) ? root : root + sep);
    if (hookInstalled) return;
    hookInstalled = true;
    const M = Module as unknown as { _resolveFilename: ResolveFilename };
    const original = M._resolveFilename;
    M._resolveFilename = function (this: unknown, request, parent, ...rest) {
        const from = parent?.filename;
        if (from && SHARED_PACKAGES.test(request) && [...pluginRoots].some((r) => from.startsWith(r))) {
            try {
                return hostRequire.resolve(request);
            } catch {
                // The server has no copy: the plugin's own
            }
        }
        return original.call(this, request, parent, ...rest);
    };
}

/** Where a server's runtime-installed plugins are kept and how they are loaded (`createCliServer({ serverPlugins })`). */
export interface CliServerPluginsOptions {
    /** `<dataDir>/server-plugins` by default. */
    dir?: string;
}

/** What the loader needs from the server. */
export interface CliServerPluginsHost {
    builder: CliPluginBuilder & {
        addInstalledPlugin(plugin: CliInstalledPlugin): unknown;
        removeInstalledPlugin(id: string): boolean;
        addConfigProvider(provider: CliStoredConfigProvider): unknown;
    };
    config: ICliConfigService;
    eventBus: ICliEventBus;
    restart: ICliServerRestart;
    /** Mounts a plugin result (`mountPlugin`), its routes reachable even when added after the host's own. */
    mount(plugin: { prefix: string; router: unknown }): void;
    /** Wires what the plugins set on the builder at runtime (filesystem storage, data explorer sources). */
    afterLoad(): void;
}

/** The `qodalis` block of a package, when it declares a server plugin; undefined otherwise. */
export function serverPluginManifestOf(pkg: unknown): CliServerPluginManifest | undefined {
    const q = (pkg as { qodalis?: unknown } | undefined)?.qodalis as Partial<CliServerPluginManifest> | undefined;
    if (!q || typeof q !== 'object' || q.kind !== CLI_SERVER_PLUGIN_KIND) return undefined;
    return q as CliServerPluginManifest;
}

/**
 * The entry file of a package: `entry` relative to the package directory, inside it, a `.js` or `.cjs` file.
 * Throws when it is missing, absolute or leaves the package.
 */
export function serverPluginEntryPath(packageDir: string, entry: unknown): string {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('the package declares no qodalis.entry');
    if (isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) throw new Error(`invalid qodalis.entry: ${entry}`);
    if (!/\.c?js$/.test(entry)) throw new Error(`qodalis.entry must be a .js or .cjs file: ${entry}`);
    const root = resolve(packageDir);
    const path = resolve(root, entry);
    if (!path.startsWith(root + sep)) throw new Error(`invalid qodalis.entry: ${entry}`);
    return path;
}

/** True for a plugin result `mountPlugin` takes. */
function isMountable(value: unknown): value is { prefix: string; router: unknown } {
    const v = value as { prefix?: unknown; router?: unknown } | undefined;
    return !!v && typeof v.prefix === 'string' && (typeof v.router === 'function' || (typeof v.router === 'object' && v.router !== null));
}

/** True for a module `addModule` takes. */
function isModule(value: unknown): value is ICliModule {
    const v = value as Partial<ICliModule> | undefined;
    return !!v && typeof v.name === 'string' && Array.isArray(v.processors);
}

/**
 * The server's runtime-installed plugins: `<dataDir>/server-plugins/installed.json` lists them (written by the admin
 * plugin's server marketplace), their packages are in `<dataDir>/server-plugins/node_modules`. At startup each
 * package's `qodalis.entry` is required and its `createPlugin(context)` called; what it returns is mounted (a plugin
 * result) or added (a module). A plugin that fails is logged and its error kept in `installed.json`: startup goes on.
 */
export class CliServerPlugins implements ICliServerPlugins {
    readonly enabled: boolean;
    readonly dir: string;
    readonly dataDir: string;
    private _states: CliServerPluginState[] = [];
    private loading?: Promise<CliServerPluginState[]>;
    private host?: CliServerPluginsHost;
    private readonly logger = createLogger('ServerPlugins');

    constructor(dataDir: string, options: CliServerPluginsOptions | false = {}) {
        this.dataDir = resolve(dataDir);
        this.enabled = options !== false;
        this.dir = resolve(options !== false && options.dir ? options.dir : join(this.dataDir, CLI_SERVER_PLUGINS_DIR));
    }

    /** Set by the server: loading starts on the next turn of the event loop (after the host's own mounts), or on {@link ready}. */
    attach(host: CliServerPluginsHost): void {
        this.host = host;
        if (!this.enabled) return;
        setImmediate(() => void this.ready());
    }

    records(): CliServerPluginRecord[] {
        const file = join(this.dir, CLI_SERVER_PLUGINS_FILE);
        if (!existsSync(file)) return [];
        let plugins: unknown;
        try {
            plugins = (JSON.parse(readFileSync(file, 'utf8')) as { plugins?: unknown }).plugins;
        } catch (err) {
            this.logger.warn(`${file} is not readable JSON: ${(err as Error).message}`);
            return [];
        }
        if (!Array.isArray(plugins)) return [];
        return plugins.filter(
            (r): r is CliServerPluginRecord =>
                !!r && isValidServerPluginName(r.name) && isValidServerPluginPackage(r.package) && isValidServerPluginVersion(r.version) && typeof r.integrity === 'string',
        );
    }

    async save(records: CliServerPluginRecord[]): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        const file = join(this.dir, CLI_SERVER_PLUGINS_FILE);
        const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
            await writeFile(temp, JSON.stringify({ plugins: records }, null, 2) + '\n', { mode: 0o600 });
            await rename(temp, file);
        } catch (err) {
            await rm(temp, { force: true });
            throw err;
        }
    }

    states(): CliServerPluginState[] {
        return this._states.map((s) => ({ ...s }));
    }

    ready(): Promise<CliServerPluginState[]> {
        if (!this.enabled || !this.host) return Promise.resolve(this.states());
        this.loading ??= this.loadAll(this.host).then(
            () => this.states(),
            (err) => {
                this.logger.error(`loading the server plugins failed: ${(err as Error)?.message ?? err}`);
                return this.states();
            },
        );
        return this.loading;
    }

    private async loadAll(host: CliServerPluginsHost): Promise<void> {
        const records = this.records();
        if (records.length === 0) return;
        shareHostPackages(join(this.dir, 'node_modules'));
        let changed = false;
        for (const record of records) {
            const state: CliServerPluginState = { name: record.name, package: record.package, version: record.version, status: 'loaded' };
            try {
                await this.loadOne(host, record);
                this.logger.info(`loaded ${record.name} (${record.package}@${record.version})`);
            } catch (err) {
                const message = String((err as Error)?.message ?? err).split('\n')[0].slice(0, 500);
                state.status = err instanceof SkippedError ? 'skipped' : 'failed';
                state.error = message;
                if (state.status === 'failed') this.logger.error(`${record.name} (${record.package}@${record.version}) not loaded: ${message}`);
                else this.logger.warn(`${record.name} (${record.package}@${record.version}) not loaded: ${message}`);
            }
            this._states.push(state);
            if ((record.error ?? undefined) !== state.error) {
                if (state.error) record.error = state.error;
                else delete record.error;
                changed = true;
            }
        }
        try {
            host.afterLoad();
        } catch (err) {
            this.logger.error(`wiring the server plugins failed: ${(err as Error).message}`);
        }
        if (changed) {
            // The errors in the installed list, for the dashboard (and cleared once a plugin loads)
            try {
                const current = this.records();
                for (const r of current) {
                    const s = this._states.find((x) => x.name === r.name && x.version === r.version);
                    if (!s) continue;
                    if (s.error) r.error = s.error;
                    else delete r.error;
                }
                await this.save(current);
            } catch (err) {
                this.logger.warn(`could not write the errors to ${CLI_SERVER_PLUGINS_FILE}: ${(err as Error).message}`);
            }
        }
    }

    private async loadOne(host: CliServerPluginsHost, record: CliServerPluginRecord): Promise<void> {
        if (host.builder.installedPlugins.some((p) => p.id === record.package && p.source !== 'marketplace')) {
            throw new SkippedError('already installed by the host');
        }
        if (this._states.some((s) => s.package === record.package && s.status === 'loaded')) throw new SkippedError('listed twice');
        const modules = resolve(this.dir, 'node_modules');
        const packageDir = resolve(modules, record.package);
        if (!packageDir.startsWith(modules + sep)) throw new Error('invalid package name');
        const packageJson = join(packageDir, 'package.json');
        if (!existsSync(packageJson)) throw new Error(`not installed in ${modules}`);
        // A symbolic link out of the directory is refused
        const real = realpathSync(packageDir);
        if (!real.startsWith(realpathSync(modules) + sep)) throw new Error('the package is outside the plugins directory');
        const pkg = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string; version?: string; description?: string };
        if (pkg.name !== record.package) throw new Error(`the installed package is ${pkg.name}, not ${record.package}`);
        if (pkg.version !== record.version) throw new Error(`the installed version is ${pkg.version}, not ${record.version}`);
        const manifest = serverPluginManifestOf(pkg);
        if (!manifest) throw new Error('not a server plugin (no qodalis.kind "server")');
        if (manifest.autoInstall === false) throw new Error(`needs setup in code${manifest.autoInstallReason ? `: ${manifest.autoInstallReason}` : ''}`);
        const entryPath = serverPluginEntryPath(packageDir, manifest.entry);
        if (!existsSync(entryPath)) throw new Error(`entry not found: ${manifest.entry}`);
        const required = createRequire(packageJson)(entryPath) as { createPlugin?: unknown; default?: { createPlugin?: unknown } };
        const createPlugin = typeof required?.createPlugin === 'function' ? required.createPlugin : required?.default?.createPlugin;
        if (typeof createPlugin !== 'function') throw new Error('the entry exports no createPlugin(context)');

        // Listed first, as installed from the marketplace (the plugin's own listing of the package is then ignored)
        host.builder.addInstalledPlugin({
            id: record.package,
            name: record.title ?? installedPluginName(record.package),
            version: record.version,
            ...(record.description ?? pkg.description ? { description: record.description ?? pkg.description } : {}),
            ...(record.icon ? { icon: record.icon } : {}),
            source: 'marketplace',
        });
        const dataDir = join(this.dataDir, 'plugin-data', record.name.replace(/[/@]/g, (c) => (c === '/' ? '+' : '')));
        mkdirSync(dataDir, { recursive: true });
        const logger = createLogger(`plugin:${record.name}`) as CliPluginLogger;
        const context: CliPluginContext = {
            pluginId: record.name,
            packageName: record.package,
            version: record.version,
            builder: host.builder,
            config: host.config,
            logger,
            dataDir,
            serverDataDir: this.dataDir,
            eventBus: host.eventBus,
            restart: host.restart,
            settings: async (options: CliPluginSettingsOptions) => {
                const provider = new CliStoredConfigProvider({
                    id: options.id ?? record.name,
                    title: options.title ?? record.title ?? installedPluginName(record.package),
                    ...(options.description ? { description: options.description } : {}),
                    ...(options.store ? { store: options.store } : {}),
                    sections: options.sections ?? [{ id: 'settings', title: 'Settings', settings: options.settings ?? [] }],
                });
                host.builder.addConfigProvider(provider);
                await provider.ready();
                return provider;
            },
        };
        try {
            await this.run(host, context, createPlugin as (c: CliPluginContext) => CliPluginEntryResult | Promise<CliPluginEntryResult>);
        } catch (err) {
            host.builder.removeInstalledPlugin(record.package);
            throw err;
        }
    }

    private async run(host: CliServerPluginsHost, context: CliPluginContext, createPlugin: (c: CliPluginContext) => CliPluginEntryResult | Promise<CliPluginEntryResult>): Promise<void> {
        const result = (await createPlugin(context)) as unknown;
        if (result === undefined || result === null) return;
        if (isMountable(result)) host.mount(result);
        else if (isModule(result)) host.builder.addModule(result);
        else throw new Error('createPlugin returned neither a plugin result (prefix, router) nor a module (name, processors)');
    }
}

/** A plugin left out on purpose (the host installed the same package). */
class SkippedError extends Error {}
