import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-plugin-filesystem';

/** This package, as listed among the server's installed plugins. */
export const filesystemJsonInstalledPlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-filesystem-json', 'FileSystem.Json') ?? {
    id: '@qodalis/cli-server-plugin-filesystem-json',
    name: 'FileSystem.Json',
};
