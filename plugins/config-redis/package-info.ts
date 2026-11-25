import { readInstalledPlugin, type CliInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package, as listed among the server's installed plugins. */
export const configRedisInstalledPlugin: CliInstalledPlugin = {
    ...(readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-config-redis', 'Config.Redis') ?? {
        id: '@qodalis/cli-server-plugin-config-redis',
        name: 'Config.Redis',
    }),
    icon: '🔴',
};
