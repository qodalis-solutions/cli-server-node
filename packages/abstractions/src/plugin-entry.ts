/**
 * Server plugins installed at runtime (from the marketplace): the entry point a plugin package declares and the
 * context the server hands it. The same contract on every platform: Node (`qodalis.entry` exporting
 * `createPlugin(context)`), Python (entry point group `qodalis_cli.plugins`) and .NET (`[assembly: CliPlugin]`).
 *
 * A Node package declares it in its `package.json`:
 *
 * ```json
 * "qodalis": { "kind": "server", "plugin": "weather", "entry": "./dist/plugin.js" }
 * ```
 *
 * and the entry module (CommonJS) exports `createPlugin`:
 *
 * ```ts
 * import type { CliPluginContext, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
 *
 * export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
 *     const settings = await context.settings({
 *         title: 'Weather',
 *         settings: [{ key: 'defaultLocation', type: 'string', default: 'London' }],
 *     });
 *     return new WeatherModule(() => String(settings.value('settings', 'defaultLocation')));
 * }
 * ```
 *
 * The same entry serves a plugin added in code: `builder.addPlugin(entry, options)` calls `createPlugin` with
 * `context.options` (the code's values: the defaults of its settings, a saved setting overrides them) and
 * `context.source` `code`. Both install paths show the same settings on the dashboard's Config page.
 *
 * A plugin whose required settings (`required: true`) have no value returns `context.needsConfiguration(missing)`:
 * it registers nothing, its state is `needs-configuration`, and it runs once they are saved and the server restarts.
 * The entry may export `order` ({@link CLI_PLUGIN_LOAD_ORDER}) to load before or after the others.
 *
 * A package that needs the host's code (the admin plugin, which hosts the dashboard) declares `"autoInstall": false`
 * with an `autoInstallReason`: the marketplace and the dashboard show "needs setup in code".
 */
import type { ICliCommandProcessor } from './cli-command-processor';
import type { ICliModule } from './cli-module';
import type { CliDashboardExtension } from './dashboard-extension';
import type { IDataExplorerProvider } from './data-explorer-provider';
import type { DataExplorerProviderOptions } from './data-explorer-types';
import type { CliInstalledPlugin } from './installed-plugin';
import type { ICliConfigProvider, ICliConfigService } from './config/config-types';
import type { CliConfigSectionDefinition, CliConfigSettingDefinition, CliStoredConfigProvider } from './config/stored-config-provider';
import type { ICliConfigStore } from './config/config-store';
import type { ICliEventBus } from './events';
import type { CliConfigEntryType, CliConfigValidation, CliConfigValue } from './config/config-types';
import type { ICliServerRestart } from './restart';

/** The kind of a server plugin package (`qodalis.kind`). */
export const CLI_SERVER_PLUGIN_KIND = 'server';
/** Where a server keeps its runtime-installed plugins, below its data directory. */
export const CLI_SERVER_PLUGINS_DIR = 'server-plugins';
/** The list of installed plugins in that directory. */
export const CLI_SERVER_PLUGINS_FILE = 'installed.json';
/** The permission to install, update and remove server plugins. */
export const CLI_PLUGINS_INSTALL_PERMISSION = 'plugins:install';

/** The `qodalis` block of a server plugin's `package.json`. */
export interface CliServerPluginManifest {
    kind: 'server';
    /** The marketplace entry's id (`jobs`); default: the package name without `cli-server-plugin-`. */
    plugin?: string;
    /** The entry module, relative to the package (`./dist/plugin.js`); required unless `autoInstall` is false. */
    entry?: string;
    /** The packages of the other platforms (`{ python: 'qodalis-cli-server-plugin-jobs', dotnet: 'Qodalis.Cli.Plugin.Jobs' }`). */
    platforms?: Record<string, string>;
    /** False when the plugin needs the host's code to run: it is listed, never installed at runtime. Default true. */
    autoInstall?: boolean;
    /** Why `autoInstall` is false, shown by the marketplace and the dashboard. */
    autoInstallReason?: string;
    title?: string;
    icon?: string;
    /** When the entry loads among the others ({@link CLI_PLUGIN_LOAD_ORDER}; the entry's own `order` export wins). Default 50. */
    order?: number;
    /**
     * The settings the entry asks for (`context.settings`), for the marketplace and the dashboard before the package
     * is installed: same schema as a dashboard plugin's `config`, plus `secret` and `requiresRestart`. A required
     * setting without a default makes the marketplace show "Needs configuration after install". Written from the
     * entry's own settings with {@link cliPluginConfigManifest}.
     */
    config?: CliPluginConfigManifest;
}

/** A setting of a server plugin's `qodalis.config` (package.json). */
export interface CliPluginConfigManifestEntry {
    key: string;
    label?: string;
    description?: string;
    type: CliConfigEntryType;
    /** `null` when none (always for a `secret`). */
    default: CliConfigValue;
    validation?: CliConfigValidation;
    /** The plugin needs a value to run (without one it loads as `needs-configuration`). */
    required?: boolean;
    requiresRestart?: boolean;
    /** True for a `secret` (and a `sensitive` setting): its value is never returned. */
    sensitive?: boolean;
}

/** The `qodalis.config` block of a server plugin's package.json. */
export interface CliPluginConfigManifest {
    entries: CliPluginConfigManifestEntry[];
    /** True when a required setting has no default: the plugin needs configuration after install. */
    needsConfiguration?: boolean;
}

/** A setting as an entry declares it (the data of a `CliConfigSettingDefinition`). */
type CliPluginSettingLike = Pick<CliConfigSettingDefinition, 'key' | 'label' | 'description' | 'type' | 'default' | 'validation' | 'required' | 'requiresRestart' | 'sensitive'>;

/** The `qodalis.config` block of a package from the settings its entry asks for (one section). */
export function cliPluginConfigManifest(settings: readonly CliPluginSettingLike[]): CliPluginConfigManifest {
    const entries = settings.map((s): CliPluginConfigManifestEntry => {
        const sensitive = s.type === 'secret' || s.sensitive === true;
        return {
            key: s.key,
            ...(s.label !== undefined ? { label: s.label } : {}),
            ...(s.description !== undefined ? { description: s.description } : {}),
            type: s.type,
            default: sensitive ? null : (s.default ?? null),
            ...(s.validation ? { validation: { ...s.validation } } : {}),
            ...(s.required || s.validation?.required ? { required: true } : {}),
            ...(s.requiresRestart ? { requiresRestart: true } : {}),
            ...(sensitive ? { sensitive: true } : {}),
        };
    });
    const empty = (v: CliConfigValue) => v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
    const needsConfiguration = entries.some((e) => e.required === true && empty(e.default));
    return { entries, ...(needsConfiguration ? { needsConfiguration: true } : {}) };
}

/**
 * When an entry loads (`order`, lower first; code-added and installed plugins sorted together, code first on a tie):
 * `AUTH` (the sign-in: users; requests wait until it is loaded; its stores, users-postgres, at `AUTH - 5`),
 * `CONFIG_STORE` (config stores: the server's default store is replaced and the providers already registered move to
 * it), `CORE` (the databases, the data explorer before its sources), `DEFAULT`, `SOURCE` (data explorer sources).
 * The same values on the Python and .NET servers.
 */
export const CLI_PLUGIN_LOAD_ORDER = { AUTH: 10, CONFIG_STORE: 20, CORE: 30, DEFAULT: 50, SOURCE: 70 } as const;

/** What plugins share with each other: the users plugin's result (`users`), its stores (`users.stores`), ... */
export interface ICliPluginServices {
    get<T = unknown>(name: string): T | undefined;
    set(name: string, value: unknown): void;
    has(name: string): boolean;
}

/** What a plugin logs through (prefixed with its id by the server). */
export interface CliPluginLogger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/**
 * The part of the server's builder (`CliBuilder` of `@qodalis/cli-server-node`) a plugin entry uses. Everything is
 * registered as if the host had done it in code.
 */
export interface CliPluginBuilder {
    addProcessor(processor: ICliCommandProcessor): unknown;
    addModule(module: ICliModule): unknown;
    addConfigProvider(provider: ICliConfigProvider): unknown;
    addDashboardExtension(extension: CliDashboardExtension): unknown;
    addInstalledPlugin(plugin: CliInstalledPlugin | string): unknown;
    /** Sets the filesystem API's storage (an `IFileStorageProvider` of `@qodalis/cli-server-plugin-filesystem`). */
    setFileStorageProvider(provider: unknown, options?: { maxUploadBytes?: number }): unknown;
    /** Adds a data explorer source. */
    addDataExplorerProvider(provider: IDataExplorerProvider | (() => IDataExplorerProvider), options: DataExplorerProviderOptions): unknown;
    /** The packages installed so far (the host's and the plugins'). */
    readonly installedPlugins: ReadonlyArray<CliInstalledPlugin>;
    /** The filesystem API's storage, when one is set. */
    readonly fileStorageProvider?: unknown;
    /**
     * Replaces the server's default config store (a `CONFIG_STORE` entry: config-redis): the providers already on the
     * default store move to the new one, those registered later start there.
     */
    replaceConfigStore?(store: ICliConfigStore): unknown;
}

/** The settings of a plugin: one {@link CliStoredConfigProvider}, registered with the server's config providers. */
export interface CliPluginSettingsOptions {
    /** The provider id (default: the plugin's id). */
    id?: string;
    /** The provider's title (default: the plugin's title). */
    title?: string;
    description?: string;
    /** One section `settings` with these settings. */
    settings?: CliConfigSettingDefinition[];
    /** Several sections instead. */
    sections?: CliConfigSectionDefinition[];
    /** Its own store (the host's store for the provider id still wins, else the server's default store). */
    store?: ICliConfigStore;
}

/** What the server hands a plugin's `createPlugin`. */
export interface CliPluginContext {
    /** The marketplace entry's id (`weather`). */
    readonly pluginId: string;
    /** The npm package (`@qodalis/cli-server-plugin-weather`). */
    readonly packageName: string;
    /** The installed version. */
    readonly version: string;
    /** The server's builder. */
    readonly builder: CliPluginBuilder;
    /** The server's configuration service (all providers). */
    readonly config: ICliConfigService;
    /** Logs prefixed with the plugin's id. */
    readonly logger: CliPluginLogger;
    /** A directory of the plugin's own (`<dataDir>/plugin-data/<id>`), created; kept across updates. */
    readonly dataDir: string;
    /** The server's data directory (`./qcli-data` by default). */
    readonly serverDataDir: string;
    /** The server's event bus. */
    readonly eventBus: ICliEventBus;
    /** The server's restart service (a setting that needs a restart marks it). */
    readonly restart: ICliServerRestart;
    /**
     * Registers the plugin's settings as a config provider (a {@link CliStoredConfigProvider}: defaults, validation,
     * values kept in the config store) and resolves once its stored values are loaded: read them with
     * `provider.value(section, key)`. Edited from the dashboard's Config page and `config set <id>.<section>.<key>`.
     */
    settings(options: CliPluginSettingsOptions): Promise<CliStoredConfigProvider>;
    /**
     * `marketplace` for a package installed at runtime, `code` for one the host added (`builder.addPlugin`).
     */
    readonly source: 'marketplace' | 'code';
    /**
     * The options the host added the plugin with (`builder.addPlugin(entry, options)`; empty from the marketplace).
     * A setting whose key is here takes the value as its default (origin `code`); a saved setting overrides it.
     * Values that are not settings (a pool, a store, a function) are read from here directly.
     */
    readonly options: Readonly<Record<string, unknown>>;
    /** What plugins share (the users plugin, its stores, the public API, ...). */
    readonly services: ICliPluginServices;
    /**
     * Marks the plugin `needs-configuration` (shown in installed.json, the API and the installed list) with the
     * settings it still needs (`settings.key`, or a reason) and returns nothing to register: `return
     * context.needsConfiguration(settings.missingRequired())`.
     */
    needsConfiguration(missing: string | string[]): undefined;
}

/**
 * What `createPlugin` returns: a plugin result the server mounts (`mountPlugin`: anything with `prefix` and
 * `router`), a module (`addModule`), or nothing when the entry registered everything on the builder itself.
 */
export type CliPluginEntryResult = { prefix: string; router: unknown } | ICliModule | void | undefined;

/** The module a plugin's entry exports. */
export interface CliPluginEntry {
    createPlugin(context: CliPluginContext): CliPluginEntryResult | Promise<CliPluginEntryResult>;
    /** When it loads among the others ({@link CLI_PLUGIN_LOAD_ORDER}, default `DEFAULT` 50). */
    order?: number;
    /** Who the plugin is, for `builder.addPlugin` (the marketplace's record says it for an installed one). */
    plugin?: CliPluginEntryInfo;
}

/** The plugin an entry belongs to (`export const plugin = { id: 'users', package: '@qodalis/cli-server-plugin-users' }`). */
export interface CliPluginEntryInfo {
    /** The marketplace entry's id (`users`): the default id of its settings provider. */
    id: string;
    /** The npm package. */
    package: string;
    version?: string;
    title?: string;
    icon?: string;
    description?: string;
}

/** A plugin installed at runtime, as `<dataDir>/server-plugins/installed.json` keeps it. */
export interface CliServerPluginRecord {
    /** The marketplace entry's id (`weather`). */
    name: string;
    /** The npm package. */
    package: string;
    version: string;
    /** `sha512-…` of the tarball, checked before it was installed. */
    integrity: string;
    title?: string;
    icon?: string;
    description?: string;
    /** ISO 8601 UTC. */
    installedAt: string;
    installedBy: string;
    /** Why the last start could not load it (cleared once it loads). */
    error?: string;
    /** `needs-configuration` when the last start found required settings without a value (cleared once it loads). */
    status?: 'needs-configuration';
    /** Those settings (`<section>.<key>`) or the reason. */
    missing?: string[];
    /** The id of its settings provider (`config get <id>`), once it registered one. */
    settings?: string;
}

/**
 * How a plugin is doing in this process: `loaded`, `needs-configuration` (required settings without a value: it
 * registered nothing and runs once they are saved and the server restarts), `failed` or `skipped`.
 */
export type CliServerPluginStatus = 'loaded' | 'needs-configuration' | 'failed' | 'skipped';

/** A plugin the server tried to load at startup (installed at runtime or added in code). */
export interface CliServerPluginState {
    name: string;
    package: string;
    version: string;
    status: CliServerPluginStatus;
    error?: string;
    /** `needs-configuration`: the settings it needs (`<section>.<key>`) or the reason. */
    missing?: string[];
    /** `marketplace` (installed.json) or `code` (`builder.addPlugin`). */
    source: 'marketplace' | 'code';
    /** The id of its settings provider, when it registered one. */
    settings?: string;
    /** Its load order. */
    order: number;
}

/** The server's runtime-installed plugins (`builder.serverPlugins` of `@qodalis/cli-server-node`). */
export interface ICliServerPlugins {
    /** False when the host turned loading off (`serverPlugins: false`). */
    readonly enabled: boolean;
    /** `<dataDir>/server-plugins`. */
    readonly dir: string;
    /** The server's data directory. */
    readonly dataDir: string;
    /** The installed list (`installed.json`); empty when there is none. */
    records(): CliServerPluginRecord[];
    /** Writes the installed list atomically. */
    save(records: CliServerPluginRecord[]): Promise<void>;
    /** What this process loaded at startup (empty before {@link ready} resolves). */
    states(): CliServerPluginState[];
    /** Resolves once the installed plugins are loaded (or failed). */
    ready(): Promise<CliServerPluginState[]>;
}
