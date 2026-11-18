import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package, as listed among the server's installed plugins (`icon` typed here too: earlier abstractions lack it). */
export const filesystemInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-filesystem', 'FileSystem') ?? { id: '@qodalis/cli-server-plugin-filesystem', name: 'FileSystem' }),
    icon: '📁',
};
