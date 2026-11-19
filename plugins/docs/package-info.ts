import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package's id (npm name). */
export const DOCS_PLUGIN_ID = '@qodalis/cli-server-plugin-docs';

/** This package, as listed among the server's installed plugins. */
export const docsInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, DOCS_PLUGIN_ID, 'Docs') ?? { id: DOCS_PLUGIN_ID, name: 'Docs' }),
    icon: '📚',
};
