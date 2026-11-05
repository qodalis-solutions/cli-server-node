import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package, as listed among the server's installed plugins. */
export const awsInstalledPlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-aws', 'Aws') ?? {
    id: '@qodalis/cli-server-plugin-aws',
    name: 'Aws',
};
