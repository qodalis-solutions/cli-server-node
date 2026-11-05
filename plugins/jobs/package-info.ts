import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-abstractions';

/** This package, as listed among the server's installed plugins. */
export const jobsInstalledPlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-jobs', 'Jobs') ?? {
    id: '@qodalis/cli-server-plugin-jobs',
    name: 'Jobs',
};
