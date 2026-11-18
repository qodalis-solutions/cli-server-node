import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package's id (npm name). */
export const AUDIT_PLUGIN_ID = '@qodalis/cli-server-plugin-audit';

/** This package, as listed among the server's installed plugins (`icon` typed here too: earlier abstractions lack it). */
export const auditInstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, AUDIT_PLUGIN_ID, 'Audit') ?? { id: AUDIT_PLUGIN_ID, name: 'Audit' }),
    icon: '🛡️',
};
