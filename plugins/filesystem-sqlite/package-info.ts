import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-plugin-filesystem';

/** This package, as listed among the server's installed plugins (`icon` typed here too: earlier abstractions lack it). */
export const filesystemSqliteInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-filesystem-sqlite', 'FileSystem.Sqlite') ?? { id: '@qodalis/cli-server-plugin-filesystem-sqlite', name: 'FileSystem.Sqlite' }),
    icon: '🪶',
};
