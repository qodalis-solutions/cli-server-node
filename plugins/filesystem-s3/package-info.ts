import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-plugin-filesystem';

/** This package, as listed among the server's installed plugins. */
export const filesystemS3InstalledPlugin: CliInstalledPlugin = readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-filesystem-s3', 'FileSystem.S3') ?? {
    id: '@qodalis/cli-server-plugin-filesystem-s3',
    name: 'FileSystem.S3',
};
