import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package, as listed among the server's installed plugins (`icon` typed here too: earlier abstractions lack it). */
export const dataExplorerInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-data-explorer', 'DataExplorer') ?? { id: '@qodalis/cli-server-plugin-data-explorer', name: 'DataExplorer' }),
    icon: '📊',
};
