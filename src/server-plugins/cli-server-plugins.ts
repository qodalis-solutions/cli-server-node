import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { rename, rm, writeFile, mkdir } from 'fs/promises';
import { randomBytes } from 'crypto';
import Module, { createRequire } from 'module';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import {
    CLI_PLUGIN_LOAD_ORDER,
    CLI_SERVER_PLUGIN_KIND,
    CLI_SERVER_PLUGINS_DIR,
    CLI_SERVER_PLUGINS_FILE,
    CliStoredConfigProvider,
    JsonFileConfigStore,
    installedPluginName,
    installedPluginOf,
    readInstalledPlugin,
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
    type CliPluginEntry,
    type CliConfigSectionDefinition,
    type CliConfigValue,
    type ICliPluginServices,
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

/**
 * Makes `require` of a shared package from a file below `root` resolve to the server's copy, and a package the plugin
 * did not bring (the server has it: the marketplace install shares it, never installs it) resolve to the server's.
 */
function shareHostPackages(root: string): void {
    // Node names modules by their real path (`/private/var/...` for `/var/...` on macOS): both are kept
    for (const path of [root, existsSync(root) ? realpathSync(root) : root]) pluginRoots.add(path.endsWith(sep) ? path : path + sep);
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
        try {
            return original.call(this, request, parent, ...rest);
        } catch (err) {
            // A dependency the server already has is never installed with the plugin: the server's copy
            if (from && !request.startsWith('.') && !isAbsolute(request) && [...pluginRoots].some((r) => from.startsWith(r))) {
                for (const req of [hostRequire, createRequire(join(process.cwd(), 'package.json'))]) {
                    try {
                        return req.resolve(request);
                    } catch {
                        // not there either
                    }
                }
            }
            throw err;
        }
    };
}

/** Where a server's runtime-installed plugins are kept and how they are loaded (`createCliServer({ serverPlugins })`). */
export interface CliServerPluginsOptions {
    /** `<dataDir>/server-plugins` by default. */
    dir?: string;
}

/** The settings file of the plugins while the server keeps its settings in memory (no default store set). */
export const CLI_PLUGIN_SETTINGS_FILE = 'plugin-settings.json';

/** What the loader needs from the server. */
export interface CliServerPluginsHost {
    builder: CliPluginBuilder & {
        addInstalledPlugin(plugin: CliInstalledPlugin): unknown;
        updateInstalledPlugin(id: string, changes: Partial<CliInstalledPlugin>): boolean;
        removeInstalledPlugin(id: string): boolean;
        addConfigProvider(provider: CliStoredConfigProvider): unknown;
        readonly pluginServices: ICliPluginServices;
        readonly configRegistry: {
            readonly hasDefaultStore: boolean;
            readonly providerStores: ReadonlyMap<string, unknown>;
            has(id: string): boolean;
            moveProvider(providerId: string, store: JsonFileConfigStore): void;
        };
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

/** The version of a code plugin nothing says one for. */
const UNKNOWN_VERSION = '0.0.0';

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

/** A version or description: a non-empty string, else undefined. */
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * The version and description of a package the host added in code, from its package.json: `<package>/package.json`
 * when the package exports it, else the package.json above its main file; resolved from the server, then from the
 * working directory. Undefined when it cannot be found.
 */
export function codePluginPackageInfo(pkg: string): { version?: string; description?: string } | undefined {
    for (const req of [hostRequire, createRequire(join(process.cwd(), 'package.json'))]) {
        for (const request of [`${pkg}/package.json`, pkg]) {
            let file: string;
            try {
                file = req.resolve(request);
            } catch {
                continue;
            }
            const found = readInstalledPlugin(dirname(file), pkg);
            if (found) return { version: text(found.version), description: text(found.description) };
        }
    }
    return undefined;
}

/** A load order: a finite number, else `DEFAULT`. */
function orderOf(...values: unknown[]): number {
    for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) return v;
    return CLI_PLUGIN_LOAD_ORDER.DEFAULT;
}

/** A value a setting can take from a plugin's code options (JSON data; not a pool, a store or a function). */
function isConfigValue(value: unknown): value is CliConfigValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isConfigValue);
    if (typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        return (proto === Object.prototype || proto === null) && Object.values(value as object).every(isConfigValue);
    }
    return false;
}

/** The sections with the code's options as the defaults of the settings they name (source `code`). */
export function withCodeDefaults(sections: CliConfigSectionDefinition[], options: Readonly<Record<string, unknown>>): CliConfigSectionDefinition[] {
    return sections.map((section) => ({
        ...section,
        settings: section.settings.map((setting) => {
            if (!Object.prototype.hasOwnProperty.call(options, setting.key)) return setting;
            const value = options[setting.key];
            if (value === undefined || !isConfigValue(value) || setting.mutable === false) return setting;
            return { ...setting, default: value, source: 'code' as const };
        }),
    }));
}

/** A plugin about to load: added in code or installed from the marketplace. */
interface Candidate {
    name: string;
    package: string;
    version: string;
    source: 'code' | 'marketplace';
    order: number;
    title?: string;
    icon?: string;
    description?: string;
    /** A code plugin whose version neither its entry nor its package.json says: the module it returns may. */
    versionUnknown?: boolean;
    options: Readonly<Record<string, unknown>>;
    createPlugin: (c: CliPluginContext) => CliPluginEntryResult | Promise<CliPluginEntryResult>;
    record?: CliServerPluginRecord;
}

/**
 * The server's plugins loaded through their entry point (`createPlugin(context)`): those the host added in code
 * (`builder.addPlugin(entry, options)`) and those installed at runtime (`<dataDir>/server-plugins/installed.json`,
 * written by the admin plugin's server marketplace, their packages in `<dataDir>/server-plugins/node_modules`). They
 * load on the next turn of the event loop, sorted by their `order` ({@link CLI_PLUGIN_LOAD_ORDER}); what an entry
 * returns is mounted (a plugin result) or added (a module). A plugin whose required settings have no value is
 * `needs-configuration`; one that fails is logged and its error kept in `installed.json`: startup goes on.
 */
export class CliServerPlugins implements ICliServerPlugins {
    readonly enabled: boolean;
    readonly dir: string;
    readonly dataDir: string;
    private _states: CliServerPluginState[] = [];
    private loading?: Promise<CliServerPluginState[]>;
    private host?: CliServerPluginsHost;
    private readonly codePlugins: Array<{ entry: CliPluginEntry; options: Record<string, unknown> }> = [];
    private authLoaded = false;
    /** Plugins at `CONFIG_STORE` still to load: the settings of those before them wait in memory for the store. */
    private configStorePending = false;
    /** Settings providers registered while a config store was pending (moved to the file store if none came). */
    private parked: string[] = [];
    private authWaiters: Array<() => void> = [];
    private readonly logger = createLogger('ServerPlugins');

    constructor(dataDir: string, options: CliServerPluginsOptions | false = {}) {
        this.dataDir = resolve(dataDir);
        this.enabled = options !== false;
        this.dir = resolve(options !== false && options.dir ? options.dir : join(this.dataDir, CLI_SERVER_PLUGINS_DIR));
    }

    /** Set by the server: loading starts on the next turn of the event loop (after the host's own mounts), or on {@link ready}. */
    attach(host: CliServerPluginsHost): void {
        this.host = host;
        setImmediate(() => void this.ready());
    }

    /** A plugin the host adds in code (`builder.addPlugin`): loaded with the installed ones, in order. */
    addCodePlugin(entry: CliPluginEntry, options: Record<string, unknown> = {}): void {
        if (!entry || typeof entry.createPlugin !== 'function') throw new Error('addPlugin: the entry exports no createPlugin(context)');
        const info = entry.plugin;
        if (!info || typeof info.id !== 'string' || typeof info.package !== 'string') throw new Error('addPlugin: the entry exports no plugin { id, package }');
        if (this.loading) throw new Error(`addPlugin(${info.id}): the plugins are already loading; add it in configure or right after createCliServer`);
        if (this.codePlugins.some((p) => p.entry.plugin?.package === info.package)) throw new Error(`addPlugin: ${info.package} is added twice`);
        this.codePlugins.push({ entry, options: { ...options } });
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
        return this._states.map((s) => ({ ...s, ...(s.missing ? { missing: [...s.missing] } : {}) }));
    }

    ready(): Promise<CliServerPluginState[]> {
        if (!this.host) return Promise.resolve(this.states());
        this.loading ??= this.loadAll(this.host).then(
            () => this.states(),
            (err) => {
                this.logger.error(`loading the server plugins failed: ${(err as Error)?.message ?? err}`);
                return this.states();
            },
        );
        void this.loading.finally(() => this.releaseAuth());
        return this.loading;
    }

    /**
     * Resolves once the sign-in plugins (order up to `AUTH`) are loaded: the server holds requests until then, so a
     * users plugin added in code or installed from the marketplace protects the very first one.
     */
    authReady(): Promise<void> | undefined {
        if (this.authLoaded || !this.host) return undefined;
        void this.ready();
        if (this.authLoaded) return undefined;
        return new Promise((resolve) => this.authWaiters.push(resolve));
    }

    private releaseAuth(): void {
        if (this.authLoaded) return;
        this.authLoaded = true;
        for (const waiter of this.authWaiters.splice(0)) waiter();
    }

    private async loadAll(host: CliServerPluginsHost): Promise<void> {
        const candidates: Candidate[] = [];
        for (const { entry, options } of this.codePlugins) {
            const info = entry.plugin!;
            // The entry's plugin info, else the package's package.json; else the module it returns says it (loadOne)
            const pkg = text(info.version) && text(info.description) ? undefined : codePluginPackageInfo(info.package);
            const version = text(info.version) ?? pkg?.version;
            const description = text(info.description) ?? pkg?.description;
            candidates.push({
                name: info.id,
                package: info.package,
                version: version ?? UNKNOWN_VERSION,
                ...(version ? {} : { versionUnknown: true }),
                source: 'code',
                order: orderOf(entry.order),
                ...(info.title ? { title: info.title } : {}),
                ...(info.icon ? { icon: info.icon } : {}),
                ...(description ? { description } : {}),
                options,
                createPlugin: entry.createPlugin.bind(entry),
            });
        }
        const records = this.enabled ? this.records() : [];
        if (records.length > 0) shareHostPackages(join(this.dir, 'node_modules'));
        for (const record of records) {
            try {
                candidates.push(this.prepare(host, record, candidates));
            } catch (err) {
                this.fail(record.name, record.package, record.version, 'marketplace', CLI_PLUGIN_LOAD_ORDER.DEFAULT, err);
            }
        }
        // Stable: code plugins first on a tie
        const sorted = candidates.map((c, i) => ({ c, i })).sort((a, b) => a.c.order - b.c.order || a.i - b.i).map((x) => x.c);
        this.configStorePending = sorted.some((c) => c.order === CLI_PLUGIN_LOAD_ORDER.CONFIG_STORE);
        for (const candidate of sorted) {
            if (candidate.order > CLI_PLUGIN_LOAD_ORDER.AUTH) this.releaseAuth();
            if (candidate.order > CLI_PLUGIN_LOAD_ORDER.CONFIG_STORE) this.settleConfigStore(host);
            try {
                await this.loadOne(host, candidate);
            } catch (err) {
                this.fail(candidate.name, candidate.package, candidate.version, candidate.source, candidate.order, err);
            }
        }
        this.releaseAuth();
        this.settleConfigStore(host);
        try {
            host.afterLoad();
        } catch (err) {
            this.logger.error(`wiring the server plugins failed: ${(err as Error).message}`);
        }
        await this.saveStates(records);
    }

    /**
     * After the `CONFIG_STORE` plugins: when none set the default store, the parked settings move to the plugins'
     * settings file (the default store, if one was set, already took them).
     */
    private settleConfigStore(host: CliServerPluginsHost): void {
        if (!this.configStorePending) return;
        this.configStorePending = false;
        const registry = host.builder.configRegistry;
        if (!registry.hasDefaultStore) {
            const file = this.settingsFile();
            for (const id of this.parked) if (!registry.providerStores.has(id)) registry.moveProvider(id, file);
        }
        this.parked = [];
    }

    private settingsFileStore?: JsonFileConfigStore;
    private settingsFile(): JsonFileConfigStore {
        return (this.settingsFileStore ??= new JsonFileConfigStore(join(this.dataDir, CLI_PLUGIN_SETTINGS_FILE)));
    }

    private fail(name: string, pkg: string, version: string, source: 'code' | 'marketplace', order: number, err: unknown): void {
        const message = String((err as Error)?.message ?? err).split('\n')[0].slice(0, 500);
        const skipped = err instanceof SkippedError;
        this._states.push({ name, package: pkg, version, status: skipped ? 'skipped' : 'failed', error: message, source, order });
        if (skipped) this.logger.warn(`${name} (${pkg}@${version}) not loaded: ${message}`);
        else this.logger.error(`${name} (${pkg}@${version}) not loaded: ${message}`);
    }

    /** The status of the installed plugins in installed.json (error, needs-configuration and its settings), for the dashboard. */
    private async saveStates(records: CliServerPluginRecord[]): Promise<void> {
        const apply = (r: CliServerPluginRecord): boolean => {
            const s = this._states.find((x) => x.source === 'marketplace' && x.name === r.name && x.version === r.version);
            if (!s) return false;
            const before = JSON.stringify([r.error, r.status, r.missing, r.settings]);
            if (s.error) r.error = s.error;
            else delete r.error;
            if (s.status === 'needs-configuration') {
                r.status = 'needs-configuration';
                r.missing = [...(s.missing ?? [])];
            } else {
                delete r.status;
                delete r.missing;
            }
            if (s.settings) r.settings = s.settings;
            return before !== JSON.stringify([r.error, r.status, r.missing, r.settings]);
        };
        if (!records.map(apply).some(Boolean)) return;
        try {
            const current = this.records();
            current.forEach(apply);
            await this.save(current);
        } catch (err) {
            this.logger.warn(`could not write the plugins' status to ${CLI_SERVER_PLUGINS_FILE}: ${(err as Error).message}`);
        }
    }

    /** An installed package checked and its entry required. */
    private prepare(host: CliServerPluginsHost, record: CliServerPluginRecord, code: Candidate[]): Candidate {
        if (code.some((c) => c.package === record.package) || host.builder.installedPlugins.some((p) => p.id === record.package && p.source !== 'marketplace')) {
            throw new SkippedError('already installed by the host');
        }
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
        const required = createRequire(packageJson)(entryPath) as Partial<CliPluginEntry> & { default?: Partial<CliPluginEntry> };
        const entry = typeof required?.createPlugin === 'function' ? required : required?.default;
        if (typeof entry?.createPlugin !== 'function') throw new Error('the entry exports no createPlugin(context)');
        const description = record.description ?? pkg.description;
        return {
            name: record.name,
            package: record.package,
            version: record.version,
            source: 'marketplace',
            order: orderOf(entry.order, manifest.order),
            title: record.title ?? manifest.title ?? installedPluginName(record.package),
            ...(record.icon ? { icon: record.icon } : {}),
            ...(description ? { description } : {}),
            options: {},
            createPlugin: entry.createPlugin.bind(entry) as Candidate['createPlugin'],
            record,
        };
    }

    private async loadOne(host: CliServerPluginsHost, candidate: Candidate): Promise<void> {
        const state: CliServerPluginState = {
            name: candidate.name,
            package: candidate.package,
            version: candidate.version,
            status: 'loaded',
            source: candidate.source,
            order: candidate.order,
        };
        // Listed first (the plugin's own listing of the package is then ignored)
        host.builder.addInstalledPlugin({
            id: candidate.package,
            name: candidate.title ?? installedPluginName(candidate.package),
            version: candidate.version,
            ...(candidate.description ? { description: candidate.description } : {}),
            ...(candidate.icon ? { icon: candidate.icon } : {}),
            source: candidate.source,
        });
        const dataDir = join(this.dataDir, 'plugin-data', candidate.name.replace(/[/@]/g, (c) => (c === '/' ? '+' : '')));
        mkdirSync(dataDir, { recursive: true });
        const logger = createLogger(`plugin:${candidate.name}`) as CliPluginLogger;
        let missing: string[] | undefined;
        const context: CliPluginContext = {
            pluginId: candidate.name,
            packageName: candidate.package,
            version: candidate.version,
            builder: host.builder,
            config: host.config,
            logger,
            dataDir,
            serverDataDir: this.dataDir,
            eventBus: host.eventBus,
            restart: host.restart,
            source: candidate.source,
            options: Object.freeze({ ...candidate.options }),
            services: host.builder.pluginServices,
            settings: async (options: CliPluginSettingsOptions) => {
                const id = options.id ?? candidate.name;
                const sections = options.sections ?? [{ id: 'settings', title: 'Settings', settings: options.settings ?? [] }];
                // While the server keeps its settings in memory, a plugin's are kept in a file of the data directory
                // (they must survive the restart they wait for); a store the host set wins. Before a CONFIG_STORE
                // plugin they wait on the default store, which it may replace (else they move to the file after it)
                const registry = host.builder.configRegistry;
                const fallback = !options.store && !registry.hasDefaultStore && !registry.providerStores.has(id);
                const parked = fallback && this.configStorePending;
                const store = options.store ?? (fallback && !parked ? this.settingsFile() : undefined);
                if (parked) this.parked.push(id);
                const provider = new CliStoredConfigProvider({
                    id,
                    title: options.title ?? candidate.title ?? installedPluginName(candidate.package),
                    ...(options.description ? { description: options.description } : {}),
                    ...(store ? { store } : {}),
                    sections: withCodeDefaults(sections, candidate.options),
                });
                host.builder.addConfigProvider(provider);
                state.settings = id;
                await provider.ready();
                return provider;
            },
            needsConfiguration: (reason: string | string[]) => {
                missing = (Array.isArray(reason) ? reason : [reason]).map(String).filter(Boolean);
                if (missing.length === 0) missing = ['settings'];
                return undefined;
            },
        };
        try {
            const result = (await candidate.createPlugin(context)) as unknown;
            this.completeInfo(host, candidate, state, result);
            // A plugin waiting for its settings registers nothing, whatever it returned
            if (!missing) this.register(host, result);
        } catch (err) {
            host.builder.removeInstalledPlugin(candidate.package);
            throw err;
        }
        if (missing) {
            state.status = 'needs-configuration';
            state.missing = missing;
            host.builder.updateInstalledPlugin(candidate.package, { status: 'needs-configuration', missing: [...missing] });
            this.logger.warn(`${candidate.name} needs configuration: ${missing.join(', ')}${state.settings ? ` (config set ${state.settings}.<section>.<key> <value>, then restart)` : ''}`);
        } else {
            this.logger.info(`loaded ${candidate.name} (${candidate.package}@${candidate.version}, ${candidate.source})`);
        }
        if (state.settings) host.builder.updateInstalledPlugin(candidate.package, { settings: state.settings });
        this._states.push(state);
    }

    /** A code plugin's version and description its entry and package.json left out, from what it returned. */
    private completeInfo(host: CliServerPluginsHost, candidate: Candidate, state: CliServerPluginState, result: unknown): void {
        if (candidate.source !== 'code' || (!candidate.versionUnknown && candidate.description)) return;
        const listed = installedPluginOf(result);
        const own = listed && listed.id === candidate.package ? listed : undefined;
        const module = isModule(result) ? result : undefined;
        const changes: Partial<CliInstalledPlugin> = {};
        if (candidate.versionUnknown) {
            const version = text(own?.version) ?? text(module?.version);
            if (version) {
                candidate.version = version;
                state.version = version;
                changes.version = version;
            }
        }
        if (!candidate.description) {
            const description = text(own?.description) ?? text(module?.description);
            if (description) {
                candidate.description = description;
                changes.description = description;
            }
        }
        if (Object.keys(changes).length > 0) host.builder.updateInstalledPlugin(candidate.package, changes);
    }

    private register(host: CliServerPluginsHost, result: unknown): void {
        if (result === undefined || result === null) return;
        if (isMountable(result)) host.mount(result);
        else if (isModule(result)) host.builder.addModule(result);
        else throw new Error('createPlugin returned neither a plugin result (prefix, router) nor a module (name, processors)');
    }
}

/** A plugin left out on purpose (the host installed the same package). */
class SkippedError extends Error {}
