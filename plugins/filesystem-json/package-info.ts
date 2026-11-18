import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-plugin-filesystem';

/** This package, as listed among the server's installed plugins (`icon` typed here too: earlier abstractions lack it). */
export const filesystemJsonInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-filesystem-json', 'FileSystem.Json') ?? { id: '@qodalis/cli-server-plugin-filesystem-json', name: 'FileSystem.Json' }),
    icon: '📄',
};
