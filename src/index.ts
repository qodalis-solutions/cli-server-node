// Abstractions
export {
    ICliCommandAuthor,
    CliCommandAuthor,
    DefaultLibraryAuthor,
    CliProcessCommand,
    ICliCommandParameterDescriptor,
    CliCommandParameterDescriptor,
    ICliCommandProcessor,
    CliCommandProcessor,
    ICliModule,
    CliModule,
} from './abstractions';

// Models
export {
    CliServerOutput,
    CliServerResponse,
    CliServerCommandDescriptor,
    CliServerCommandParameterDescriptorDto,
} from './models';

// Services
export {
    ICliCommandRegistry,
    CliCommandRegistry,
    ICliResponseBuilder,
    CliResponseBuilder,
    ICliCommandExecutorService,
    CliCommandExecutorService,
    CliEventSocketManager,
    CliShellSessionManager,
} from './services';

// Controllers
export { createCliController } from './controllers/cli-controller';
export { createCliControllerV2 } from './controllers/cli-controller-v2';
export { createCliVersionController } from './controllers/cli-version-controller';
export { createFilesystemRouter } from './controllers/filesystem-controller';

// Extensions
export { CliBuilder } from './extensions';

// Jobs plugin (re-export for backward compatibility)
export {
    CliJobsBuilder,
    CliJobScheduler,
    CliJobExecutionContext,
    CliJobLogger,
    InMemoryJobStorageProvider,
    JobDto,
    JobError,
    parseInterval,
    createCliJobsController,
} from '@qodalis/cli-server-plugin-jobs';

// Filesystem (legacy)
export { FileSystemOptions, FileSystemPathValidator } from './filesystem';

// Filesystem plugin
export {
    IFileStorageProvider,
    FileEntry,
    FileStat,
    InMemoryFileStorageProvider,
    OsFileStorageProvider,
    OsProviderOptions,
    FileSystemModule,
    FileNotFoundError,
    PermissionDeniedError,
    FileExistsError,
    NotADirectoryError,
    IsADirectoryError,
} from '@qodalis/cli-server-plugin-filesystem';

// Filesystem JSON provider
export { JsonFileStorageProvider, JsonFileProviderOptions } from '@qodalis/cli-server-plugin-filesystem-json';

// Filesystem SQLite provider
export { SqliteFileStorageProvider, SqliteProviderOptions } from '@qodalis/cli-server-plugin-filesystem-sqlite';

// Filesystem S3 provider
export { S3FileStorageProvider, S3ProviderOptions } from '@qodalis/cli-server-plugin-filesystem-s3';

// Processors
export { CliEchoCommandProcessor } from './processors/cli-echo-command-processor';
export { CliStatusCommandProcessor } from './processors/cli-status-command-processor';
export { CliSystemCommandProcessor } from './processors/cli-system-command-processor';
export { CliHttpCommandProcessor } from './processors/cli-http-command-processor';
export { CliHashCommandProcessor } from './processors/cli-hash-command-processor';
export { CliBase64CommandProcessor } from './processors/cli-base64-command-processor';
export { CliUuidCommandProcessor } from './processors/cli-uuid-command-processor';

// Server factory
export { createCliServer, CliServerOptions } from './create-cli-server';
