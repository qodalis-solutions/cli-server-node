import { ICliCommandProcessor, ICliModule, ICliJob, CliJobOptions, ICliJobStorageProvider } from '../abstractions';
import { FileSystemOptions } from '../filesystem';
import { IFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { CliCommandRegistry } from '../services';

export interface JobRegistrationEntry {
    job: ICliJob;
    options: CliJobOptions;
}

export class CliBuilder {
    private readonly _registry: CliCommandRegistry;
    private _fileSystemOptions?: FileSystemOptions;
    private _fileStorageProvider?: IFileStorageProvider;
    private readonly _jobRegistrations: JobRegistrationEntry[] = [];
    private _jobStorageProvider?: ICliJobStorageProvider;

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

    addJob(job: ICliJob, options: CliJobOptions): CliBuilder {
        this._jobRegistrations.push({ job, options });
        return this;
    }

    setJobStorageProvider(provider: ICliJobStorageProvider): CliBuilder {
        this._jobStorageProvider = provider;
        return this;
    }

    get jobRegistrations(): ReadonlyArray<JobRegistrationEntry> {
        return this._jobRegistrations;
    }

    get jobStorageProvider(): ICliJobStorageProvider | undefined {
        return this._jobStorageProvider;
    }
}
