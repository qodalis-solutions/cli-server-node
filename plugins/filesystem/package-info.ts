import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package, as listed among the server's installed plugins. */
export const filesystemInstalledPlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-filesystem', 'FileSystem') ?? {
    id: '@qodalis/cli-server-plugin-filesystem',
    name: 'FileSystem',
};
