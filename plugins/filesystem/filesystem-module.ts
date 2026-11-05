import { CliModule, ICliCommandProcessor } from '@qodalis/cli-server-abstractions';
import { CLI_INSTALLED_PLUGIN } from '@qodalis/cli-server-abstractions';
import { filesystemInstalledPlugin } from './package-info';

/** CLI module that registers the pluggable file storage subsystem. */
export class FileSystemModule extends CliModule {
    /** The package this class belongs to, listed among the server's installed plugins. */
    static readonly [CLI_INSTALLED_PLUGIN] = filesystemInstalledPlugin;

    name = 'filesystem';
    version = '1.0.0';
    description = 'Provides pluggable file storage with in-memory and OS providers';
    processors: ICliCommandProcessor[] = [];
}
