import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package's id (npm name). */
export const PUBLIC_API_PLUGIN_ID = '@qodalis/cli-server-plugin-public-api';

/** This package, as listed among the server's installed plugins. */
export const publicApiInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, PUBLIC_API_PLUGIN_ID, 'Public API') ?? { id: PUBLIC_API_PLUGIN_ID, name: 'Public API' }),
    icon: '🔑',
};
