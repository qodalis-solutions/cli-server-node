import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package's id (npm name). */
export const MIGRATIONS_PLUGIN_ID = '@qodalis/cli-server-plugin-migrations';

/** This package, as listed among the server's installed plugins. */
export const migrationsInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, MIGRATIONS_PLUGIN_ID, 'Migrations') ?? { id: MIGRATIONS_PLUGIN_ID, name: 'Migrations' }),
    icon: '🗄️',
};
