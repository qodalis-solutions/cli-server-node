import { ICliCommandProcessor, ICliModule, IDataExplorerProvider, DataExplorerProviderOptions } from '../abstractions';
import type { CliServerRuntimeOptions } from '../auth/cli-server-auth';
import { FileSystemApiOptions, FileSystemOptions } from '../filesystem';
import { IFileStorageProvider, OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { DataExplorerBuilder, DataExplorerProviderFactory } from '@qodalis/cli-server-plugin-data-explorer';
import { CliCommandRegistry } from '../services';
import type { McpToolProvider } from '../mcp/mcp-types';
import {
    CliDashboardExtension,
    CliInstalledPlugin,
    installedPluginOf,
    readInstalledPlugin,
    validateDashboardExtension,
    type AuditEntry,
    type ICliAuditStore,
    type ICliConfigProvider,
    type ICliEventBus,
    type ICliConfigStore,
} from '@qodalis/cli-server-abstractions';
import { CliConfigRegistry } from '../config/cli-config-registry';
import { CliConfigService } from '../config/cli-config-service';
import {
    CliPermissionCatalog,
    CliPermissionInput,
    CliPermissionSurface,
    CORE_PERMISSIONS,
} from '../permissions/cli-permission-catalog';

const CORE_PACKAGE = '@qodalis/cli-server-node';
const FILESYSTEM_PACKAGE = '@qodalis/cli-server-plugin-filesystem';
const DATA_EXPLORER_PACKAGE = '@qodalis/cli-server-plugin-data-explorer';

/** The server itself, listed first among the installed plugins. */
const corePlugin: CliInstalledPlugin = {
    ...(readInstalledPlugin(__dirname, CORE_PACKAGE, 'Core') ?? { id: CORE_PACKAGE, name: 'Core' }),
    icon: '🖥️',
};

/**
 * Fluent builder for configuring CLI server processors, modules, filesystem, and data explorer providers.
 * Passed to the `configure` callback in {@link CliServerOptions}.
 */
export class CliBuilder {
    private readonly _registry: CliCommandRegistry;
    private readonly _modules: ICliModule[] = [];
    private _fileSystemOptions?: FileSystemOptions;
    private _fileStorageProvider?: IFileStorageProvider;
    private _fileSystemApiOptions: FileSystemApiOptions = {};
    private _dataExplorerBuilder?: DataExplorerBuilder;
    private readonly _mcpToolProviders: McpToolProvider[] = [];
    private readonly _installedPlugins: CliInstalledPlugin[] = [];
    private readonly _dashboardExtensions: CliDashboardExtension[] = [];
    private readonly _dashboardModuleDirs = new Map<string, string | false>();

    /**
     * Server-wide runtime options set by plugins (e.g. `externalAuthentication`,
     * set by the users plugin with an external auth adapter) and read by others
     * (the admin dashboard's sign-in mode).
     */
    readonly serverOptions: CliServerRuntimeOptions = { externalAuthentication: false, jobsEnabled: false };

    /**
     * The permission catalog served by the users plugin (`GET /api/v1/qcli/permissions`):
     * core's permissions, then the plugins', then the host's ({@link addPermissions}).
     */
    readonly permissions = new CliPermissionCatalog();

    /** The config providers and the store of their writable settings (see {@link addConfigProvider}). */
    readonly configRegistry = new CliConfigRegistry();
    private _configAuditStore?: ICliAuditStore;
    private _configAudit?: () => ((entry: AuditEntry) => Promise<void>) | undefined;
    private _configEventBus?: () => ICliEventBus | undefined;

    /**
     * The server's configuration (`GET/PATCH /api/v1/qcli/config`, the `config` command, the
     * `config_*` MCP tools): providers filtered by permission, secrets masked, changes validated,
     * audited (`config.update`) and published (`config:changed`).
     */
    readonly config: CliConfigService = new CliConfigService(this.configRegistry, {
        audit: () => this.auditSink,
        eventBus: () => this._configEventBus?.(),
    });

    /**
     * Where the server's own changes are audited (`config.update`, the admin plugin's `dashboard.plugin.*`):
     * the store set with `setConfigAuditStore`, else the auth provider's log (the users plugin's). Undefined
     * when there is neither.
     */
    get auditSink(): ((entry: AuditEntry) => Promise<void>) | undefined {
        if (this._configAuditStore) {
            const store = this._configAuditStore;
            return (entry) => store.log(entry);
        }
        return this._configAudit?.();
    }

    constructor(registry: CliCommandRegistry) {
        this._registry = registry;
        this.addInstalledPlugin(corePlugin);
        this.permissions.add(CORE_PERMISSIONS, 'cli');
    }

    /**
     * Registers permissions in the catalog, at startup. The host registers the
     * permissions its own routes check (`surface` `host`, the default), which host
     * tokens may carry; plugins register theirs as `cli`. Throws on an invalid entry
     * or a name already registered.
     *
     * @example
     * ```ts
     * builder.addPermissions([{ name: 'rates:read', description: 'Official exchange rates', group: 'Rates' }]);
     * ```
     */
    addPermissions(entries: readonly CliPermissionInput[], surface: CliPermissionSurface = 'host'): CliBuilder {
        this.permissions.add(entries, surface);
        return this;
    }

    /**
     * Lists a server plugin package among the installed plugins (once, in the order
     * added), shown on the admin dashboard's plugins page
     * (`GET /api/v1/qcli/plugins/installed`). The built-in plugins list themselves
     * when added (`mountPlugin`, `addModule`, `setFileStorageProvider`,
     * `addDataExplorerProvider`, ...); call it from a plugin of your own with its
     * description, or with a directory inside the package (e.g. `__dirname`) to read
     * its `package.json`.
     */
    addInstalledPlugin(plugin: CliInstalledPlugin | string): CliBuilder {
        const resolved = typeof plugin === 'string' ? readInstalledPlugin(plugin) : plugin;
        if (resolved && !this._installedPlugins.some((p) => p.id === resolved.id)) {
            this._installedPlugins.push({ ...resolved });
        }
        return this;
    }

    /**
     * Adds a page to the admin dashboard: the dashboard lists it in its navigation and loads
     * `entry` (an ES module the plugin serves) when it is opened. Served by the admin plugin at
     * `GET /api/v1/qcli/dashboard/extensions`, in registration order. Throws
     * `invalid dashboard extension: <reason>` or `dashboard extension already registered: <id>`.
     *
     * @example
     * ```ts
     * builder.addDashboardExtension({
     *     id: 'billing', title: 'Billing', icon: '💳', group: 'data', permission: 'billing:read',
     *     entry: '/billing/admin/extension.js', styles: ['/billing/admin/extension.css'],
     * });
     * ```
     */
    addDashboardExtension(extension: CliDashboardExtension): CliBuilder {
        const valid = validateDashboardExtension(extension);
        if (this._dashboardExtensions.some((e) => e.id === valid.id)) {
            throw new Error(`dashboard extension already registered: ${valid.id}`);
        }
        this._dashboardExtensions.push(valid);
        return this;
    }

    /**
     * Removes a dashboard extension at runtime (the admin plugin's marketplace plugins); the list
     * (`GET /api/v1/qcli/dashboard/extensions`) reads the registry on every request. False when no
     * extension has that id.
     */
    removeDashboardExtension(id: string): boolean {
        const index = this._dashboardExtensions.findIndex((e) => e.id === id);
        if (index < 0) return false;
        this._dashboardExtensions.splice(index, 1);
        return true;
    }

    /**
     * Where the build of a dashboard page the server itself serves is (`filesystem`, `data-explorer`:
     * `@qodalis/cli-dashboard-module-<id>`); by default the copy in the plugin package, else the installed module
     * package. `false` leaves the page out.
     */
    setDashboardModuleDir(id: 'filesystem' | 'data-explorer', dir: string | false): CliBuilder {
        this._dashboardModuleDirs.set(id, dir);
        return this;
    }

    /** The build set with `setDashboardModuleDir` (undefined: the default). */
    dashboardModuleDir(id: 'filesystem' | 'data-explorer'): string | false | undefined {
        return this._dashboardModuleDirs.get(id);
    }

    /** The dashboard extensions registered so far, in registration order. */
    get dashboardExtensions(): ReadonlyArray<CliDashboardExtension> {
        return this._dashboardExtensions;
    }

    /** The server plugin packages installed so far, the server itself (`Core`) first. */
    get installedPlugins(): ReadonlyArray<CliInstalledPlugin> {
        return this._installedPlugins;
    }

    /** Lists the package a module, provider or plugin result carries (see `CLI_INSTALLED_PLUGIN`), if any. */
    private _addInstalledPluginOf(value: unknown): void {
        const plugin = installedPluginOf(value);
        if (plugin) this.addInstalledPlugin(plugin);
    }

    /** Registers a single command processor. */
    addProcessor(processor: ICliCommandProcessor): CliBuilder {
        this._registry.register(processor);
        return this;
    }

    /** Registers a module, its command processors and its config providers (`configProviders`). */
    addModule(module: ICliModule): CliBuilder {
        this._modules.push(module);
        this._addInstalledPluginOf(module);
        for (const processor of module.processors) {
            this._registry.register(processor, module.name);
        }
        for (const provider of module.configProviders ?? []) {
            this.addConfigProvider(provider);
        }
        if (module.permissions?.length) {
            // A name already in the catalog (the host's, or the module added twice) stays as registered
            const known = new Set(this.permissions.all().map((p) => p.name.toLowerCase()));
            const fresh = module.permissions.filter((p) => typeof p?.name !== 'string' || !known.has(p.name.toLowerCase()));
            if (fresh.length) this.addPermissions(fresh, 'cli');
        }
        return this;
    }

    /**
     * Registers a config provider: its sections are listed by `GET /api/v1/qcli/config` and the
     * `config` command; a provider that also implements `ICliConfigWriter` can be changed. A
     * `CliStoredConfigProvider` keeps its changes in the server's config store. Throws
     * `config provider already registered: <id>`.
     *
     * @example
     * ```ts
     * builder.addConfigProvider(new CliStoredConfigProvider({
     *     id: 'billing', title: 'Billing',
     *     sections: [{ id: 'invoices', settings: [{ key: 'dueDays', type: 'number', default: 30, validation: { min: 1 } }] }],
     * }));
     * ```
     */
    addConfigProvider(provider: ICliConfigProvider): CliBuilder {
        this.configRegistry.add(provider);
        return this;
    }

    /** The registered config providers, sorted by `order`, then id. */
    get configProviders(): ReadonlyArray<ICliConfigProvider> {
        return this.configRegistry.providers;
    }

    /**
     * Keeps writable settings in `store`: a `JsonFileConfigStore` (a file, or a section of the
     * app's settings file), the databases plugin's `CliDatabaseConfigStore`, the config-redis
     * plugin's `CliRedisConfigStore`, ...
     *
     * - Without `providerId`: the default store, for every provider without a store of its own
     *   (in memory, lost on restart, unless set). Set it in `configure`, before the server is created.
     * - With `providerId`: the store of that provider only, winning over its own store. Set it
     *   before the provider is registered (in `configure` for plugins mounted later).
     *
     * ```ts
     * builder.setConfigStore(new JsonFileConfigStore('config.json'));
     * builder.setConfigStore(new CliRedisConfigStore({ url: process.env.REDIS_URL }), 'jobs');
     * ```
     */
    setConfigStore(store: ICliConfigStore, providerId?: string): CliBuilder {
        this.configRegistry.setStore(store, providerId);
        return this;
    }

    /**
     * Writes config changes (`config.update`) to this audit log. By default they go to the auth
     * provider's (the users plugin's audit log), when one is installed.
     */
    setConfigAuditStore(store: ICliAuditStore | undefined): CliBuilder {
        this._configAuditStore = store;
        return this;
    }

    /** Used by `createCliServer`: the default audit sink (the auth provider's) and the event bus. */
    attachConfigServices(services: {
        audit: () => ((entry: AuditEntry) => Promise<void>) | undefined;
        eventBus: () => ICliEventBus | undefined;
    }): void {
        this._configAudit = services.audit;
        this._configEventBus = services.eventBus;
    }

    /** Returns all registered modules. */
    get modules(): ReadonlyArray<ICliModule> {
        return this._modules;
    }

    /** Configures the filesystem API with path-based access control (and `maxUploadBytes`). */
    addFileSystem(options: FileSystemOptions): CliBuilder {
        this._fileSystemOptions = options;
        this.addInstalledPlugin(filesystemPlugin());
        this._fileSystemApiOptions = { maxUploadBytes: options.maxUploadBytes };
        return this;
    }

    /** Returns the underlying command registry. */
    get registry(): CliCommandRegistry {
        return this._registry;
    }

    /**
     * Sets a custom file storage provider for the filesystem API. `options`
     * configures the HTTP API (e.g. `maxUploadBytes`, default 100 MiB).
     */
    setFileStorageProvider(provider: IFileStorageProvider, options?: FileSystemApiOptions): CliBuilder {
        this._fileStorageProvider = provider;
        this.addInstalledPlugin(filesystemPlugin());
        this._addInstalledPluginOf(provider);
        if (options) {
            this._fileSystemApiOptions = { ...options };
        }
        return this;
    }

    /** Options of the filesystem HTTP API (`maxUploadBytes`). */
    get fileSystemApiOptions(): FileSystemApiOptions {
        return this._fileSystemApiOptions;
    }

    /** Returns the configured filesystem options, if any. */
    get fileSystemOptions(): FileSystemOptions | undefined {
        return this._fileSystemOptions;
    }

    /** Returns the configured file storage provider, if any. */
    get fileStorageProvider(): IFileStorageProvider | undefined {
        return this._fileStorageProvider;
    }

    /** Registers a data explorer provider with its configuration options. */
    addDataExplorerProvider(
        providerOrFactory: IDataExplorerProvider | DataExplorerProviderFactory,
        options: DataExplorerProviderOptions,
    ): CliBuilder {
        if (!this._dataExplorerBuilder) {
            this._dataExplorerBuilder = new DataExplorerBuilder();
        }
        this.addInstalledPlugin(
            installedPluginOf(this._dataExplorerBuilder) ?? { id: DATA_EXPLORER_PACKAGE, name: 'DataExplorer' },
        );
        // A factory is called right away anyway (DataExplorerBuilder); its provider names the package
        const provider = typeof providerOrFactory === 'function' ? providerOrFactory() : providerOrFactory;
        this._addInstalledPluginOf(provider);
        this._dataExplorerBuilder.addProvider(provider, options);
        return this;
    }

    /** Returns the data explorer builder, if any providers have been registered. */
    get dataExplorerBuilder(): DataExplorerBuilder | undefined {
        return this._dataExplorerBuilder;
    }

    /**
     * Registers an MCP tool provider (used when the server's `mcp` option is on).
     * On a name collision built-in feature tools win, then providers in registration
     * order, then command tools.
     */
    addMcpToolProvider(provider: McpToolProvider): CliBuilder {
        this._mcpToolProviders.push(provider);
        return this;
    }

    /** MCP tool providers registered by plugins and the host, in registration order. */
    get mcpToolProviders(): ReadonlyArray<McpToolProvider> {
        return this._mcpToolProviders;
    }
}

/** The filesystem plugin package (its in-box OS and in-memory providers). */
function filesystemPlugin(): CliInstalledPlugin {
    return installedPluginOf(OsFileStorageProvider) ?? { id: FILESYSTEM_PACKAGE, name: 'FileSystem' };
}
