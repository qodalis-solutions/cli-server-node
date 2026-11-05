import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package, as listed among the server's installed plugins. */
export const dataExplorerInstalledPlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-data-explorer', 'DataExplorer') ?? {
    id: '@qodalis/cli-server-plugin-data-explorer',
    name: 'DataExplorer',
};
