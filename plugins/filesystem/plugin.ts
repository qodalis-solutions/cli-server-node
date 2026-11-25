/**
 * The entry point of the filesystem plugin installed at runtime (`qodalis.entry`): the filesystem API, the `fs_*`
 * MCP tools and the dashboard's Files page over folders of the server's disk. The folders are a setting (none by
 * default: nothing is served until some are set, then a restart), and the storage is read-only unless `readOnly` is
 * turned off. Refused when the host (or another plugin) already set the filesystem storage.
 */
import type { CliPluginContext, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { OsFileStorageProvider, readOnlyFileStorage } from './index';

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    if (context.builder.fileStorageProvider) throw new Error('the filesystem storage is already set by the host or another plugin');
    // Not `filesystem`: the server's own provider of that id describes the storage in use
    const settings = await context.settings({
        id: 'filesystem-os',
        title: 'Filesystem (server disk)',
        description: "Folders of the server's disk served by the filesystem API",
        settings: [
            {
                key: 'roots',
                label: 'Folders',
                description: 'Absolute paths served (and everything below them); none: the filesystem API serves nothing',
                type: 'string[]',
                default: [],
                requiresRestart: true,
                validation: { pattern: '^(/|[A-Za-z]:[\\\\/]).*' },
            },
            {
                key: 'readOnly',
                label: 'Read-only',
                description: 'Only list, read and download: uploads, new folders and deletes are refused',
                type: 'boolean',
                default: true,
                requiresRestart: true,
            },
        ],
    });
    const roots = (settings.value('settings', 'roots') as string[] | null) ?? [];
    if (roots.length === 0) {
        context.logger.warn('no folders set: config set filesystem-os.settings.roots \'["/srv/files"]\', then restart');
        return;
    }
    const storage = new OsFileStorageProvider({ allowedPaths: roots });
    context.builder.setFileStorageProvider(settings.value('settings', 'readOnly') === false ? storage : readOnlyFileStorage(storage));
}
