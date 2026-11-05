import { ICliCommandProcessor, ICliModule, IDataExplorerProvider, DataExplorerProviderOptions } from '../abstractions';
import type { CliServerRuntimeOptions } from '../auth/cli-server-auth';
import { FileSystemApiOptions, FileSystemOptions } from '../filesystem';
import { IFileStorageProvider, OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { DataExplorerBuilder, DataExplorerProviderFactory } from '@qodalis/cli-server-plugin-data-explorer';
import { CliCommandRegistry } from '../services';
import type { McpToolProvider } from '../mcp/mcp-types';
import { CliInstalledPlugin, installedPluginOf, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

const CORE_PACKAGE = '@qodalis/cli-server-node';
const FILESYSTEM_PACKAGE = '@qodalis/cli-server-plugin-filesystem';
const DATA_EXPLORER_PACKAGE = '@qodalis/cli-server-plugin-data-explorer';

/** The server itself, listed first among the installed plugins. */
const corePlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, CORE_PACKAGE, 'Core') ?? { id: CORE_PACKAGE, name: 'Core' };

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

    /**
     * Server-wide runtime options set by plugins (e.g. `externalAuthentication`,
     * set by the users plugin with an external auth adapter) and read by others
     * (the admin dashboard's sign-in mode).
     */
    readonly serverOptions: CliServerRuntimeOptions = { externalAuthentication: false, jobsEnabled: false };

    constructor(registry: CliCommandRegistry) {
        this._registry = registry;
        this.addInstalledPlugin(corePlugin);
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

    /** Registers a module and all of its command processors. */
    addModule(module: ICliModule): CliBuilder {
        this._modules.push(module);
        this._addInstalledPluginOf(module);
        for (const processor of module.processors) {
            this._registry.register(processor);
        }
        return this;
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
