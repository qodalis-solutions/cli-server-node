import { CliModule, ICliCommandProcessor } from '@qodalis/cli-server-abstractions';

export class FileSystemModule extends CliModule {
    name = 'filesystem';
    version = '1.0.0';
    description = 'Provides pluggable file storage with in-memory and OS providers';
    processors: ICliCommandProcessor[] = [];
}
