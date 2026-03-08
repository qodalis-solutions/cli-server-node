import { ICliCommandProcessor, ICliModule } from '../abstractions';
import { FileSystemOptions } from '../filesystem';
import { IFileStorageProvider } from '../../plugins/filesystem';
import { CliCommandRegistry } from '../services';

export class CliBuilder {
    private readonly _registry: CliCommandRegistry;
    private _fileSystemOptions?: FileSystemOptions;
    private _fileStorageProvider?: IFileStorageProvider;

    constructor(registry: CliCommandRegistry) {
        this._registry = registry;
    }

    addProcessor(processor: ICliCommandProcessor): CliBuilder {
        this._registry.register(processor);
        return this;
    }

    addModule(module: ICliModule): CliBuilder {
        for (const processor of module.processors) {
            this._registry.register(processor);
        }
        return this;
    }

    addFileSystem(options: FileSystemOptions): CliBuilder {
        this._fileSystemOptions = options;
        return this;
    }

    get registry(): CliCommandRegistry {
        return this._registry;
    }

    setFileStorageProvider(provider: IFileStorageProvider): CliBuilder {
        this._fileStorageProvider = provider;
        return this;
    }

    get fileSystemOptions(): FileSystemOptions | undefined {
        return this._fileSystemOptions;
    }

    get fileStorageProvider(): IFileStorageProvider | undefined {
        return this._fileStorageProvider;
    }
}
