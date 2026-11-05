import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-plugin-filesystem';

/** This package, as listed among the server's installed plugins. */
export const filesystemSqliteInstalledPlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-filesystem-sqlite', 'FileSystem.Sqlite') ?? {
    id: '@qodalis/cli-server-plugin-filesystem-sqlite',
    name: 'FileSystem.Sqlite',
};
