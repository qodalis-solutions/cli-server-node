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
} from './services';

// Controllers
export { createCliController } from './controllers/cli-controller';
export { createCliControllerV2 } from './controllers/cli-controller-v2';
export { createCliVersionController } from './controllers/cli-version-controller';

// Extensions
export { CliBuilder } from './extensions';

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
