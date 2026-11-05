import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package, as listed among the server's installed plugins. */
export const weatherInstalledPlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-weather', 'Weather') ?? {
    id: '@qodalis/cli-server-plugin-weather',
    name: 'Weather',
};
