import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package's id (npm name). */
export const DATABASES_PLUGIN_ID = '@qodalis/cli-server-plugin-databases';

/** This package, as listed among the server's installed plugins. */
export const databasesInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, DATABASES_PLUGIN_ID, 'Databases') ?? { id: DATABASES_PLUGIN_ID, name: 'Databases' }),
    icon: '🗄️',
};
