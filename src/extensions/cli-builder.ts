import { ICliCommandProcessor, ICliModule, IDataExplorerProvider, DataExplorerProviderOptions } from '../abstractions';
import { FileSystemOptions } from '../filesystem';
import { IFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { DataExplorerBuilder, DataExplorerProviderFactory } from '@qodalis/cli-server-plugin-data-explorer';
import { CliCommandRegistry } from '../services';

/**
 * Fluent builder for configuring CLI server processors, modules, filesystem, and data explorer providers.
 * Passed to the `configure` callback in {@link CliServerOptions}.
 */
export class CliBuilder {
    private readonly _registry: CliCommandRegistry;
    private readonly _modules: ICliModule[] = [];
    private _fileSystemOptions?: FileSystemOptions;
    private _fileStorageProvider?: IFileStorageProvider;
    private _dataExplorerBuilder?: DataExplorerBuilder;

    constructor(registry: CliCommandRegistry) {
        this._registry = registry;
    }

    /** Registers a single command processor. */
    addProcessor(processor: ICliCommandProcessor): CliBuilder {
        this._registry.register(processor);
        return this;
    }

    /** Registers a module and all of its command processors. */
    addModule(module: ICliModule): CliBuilder {
        this._modules.push(module);
        for (const processor of module.processors) {
            this._registry.register(processor);
        }
        return this;
    }

    /** Returns all registered modules. */
    get modules(): ReadonlyArray<ICliModule> {
        return this._modules;
    }

    /** Configures the filesystem API with path-based access control. */
    addFileSystem(options: FileSystemOptions): CliBuilder {
        this._fileSystemOptions = options;
        return this;
    }

    /** Returns the underlying command registry. */
    get registry(): CliCommandRegistry {
        return this._registry;
    }

    /** Sets a custom file storage provider for the filesystem API. */
    setFileStorageProvider(provider: IFileStorageProvider): CliBuilder {
        this._fileStorageProvider = provider;
        return this;
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
        this._dataExplorerBuilder.addProvider(providerOrFactory, options);
        return this;
    }

    /** Returns the data explorer builder, if any providers have been registered. */
    get dataExplorerBuilder(): DataExplorerBuilder | undefined {
        return this._dataExplorerBuilder;
    }
}
