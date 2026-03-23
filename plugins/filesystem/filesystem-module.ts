import { CliModule, ICliCommandProcessor } from '@qodalis/cli-server-abstractions';

/** CLI module that registers the pluggable file storage subsystem. */
export class FileSystemModule extends CliModule {
    name = 'filesystem';
    version = '1.0.0';
    description = 'Provides pluggable file storage with in-memory and OS providers';
    processors: ICliCommandProcessor[] = [];
}
