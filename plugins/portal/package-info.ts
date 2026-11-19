import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package's id (npm name). */
export const PORTAL_PLUGIN_ID = '@qodalis/cli-server-plugin-portal';

/** This package, as listed among the server's installed plugins. */
export const portalInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, PORTAL_PLUGIN_ID, 'Portal') ?? { id: PORTAL_PLUGIN_ID, name: 'Portal' }),
    icon: '🧭',
};
