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
 * A package that needs the host's code (an auth provider, a store replacing a core service) declares
 * `"autoInstall": false` with an `autoInstallReason`: the marketplace and the dashboard show "needs setup in code".
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
}

/**
 * What `createPlugin` returns: a plugin result the server mounts (`mountPlugin`: anything with `prefix` and
 * `router`), a module (`addModule`), or nothing when the entry registered everything on the builder itself.
 */
export type CliPluginEntryResult = { prefix: string; router: unknown } | ICliModule | void | undefined;

/** The module a plugin's entry exports. */
export interface CliPluginEntry {
    createPlugin(context: CliPluginContext): CliPluginEntryResult | Promise<CliPluginEntryResult>;
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
}

/** How a runtime-installed plugin is doing in this process. */
export type CliServerPluginStatus = 'loaded' | 'failed' | 'skipped';

/** A plugin the server tried to load at startup. */
export interface CliServerPluginState {
    name: string;
    package: string;
    version: string;
    status: CliServerPluginStatus;
    error?: string;
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
