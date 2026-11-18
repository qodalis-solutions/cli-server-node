import { CliInstalledPlugin, readInstalledPlugin } from '@qodalis/cli-server-plugin-filesystem';

/** This package, as listed among the server's installed plugins (`icon` typed here too: earlier abstractions lack it). */
export const filesystemS3InstalledPlugin: CliInstalledPlugin & { icon?: string } = {
    ...(readInstalledPlugin(__dirname, '@qodalis/cli-server-plugin-filesystem-s3', 'FileSystem.S3') ?? { id: '@qodalis/cli-server-plugin-filesystem-s3', name: 'FileSystem.S3' }),
    icon: '🪣',
};
