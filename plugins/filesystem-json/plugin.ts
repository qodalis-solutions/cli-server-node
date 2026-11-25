/**
 * The entry point of the JSON file storage installed at runtime (`qodalis.entry`): the filesystem API over a virtual
 * tree kept in one JSON file (default `<dataDir>/plugin-data/filesystem-json/files.json`). Read-only unless
 * `readOnly` is turned off. Refused when the host (or another plugin) already set the filesystem storage.
 */
import { isAbsolute, join } from 'path';
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { readOnlyFileStorage } from '@qodalis/cli-server-plugin-filesystem';
import { JsonFileStorageProvider } from './json-file-provider';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'filesystem-json', package: '@qodalis/cli-server-plugin-filesystem-json', title: 'Filesystem JSON', icon: '🗂️' };

/** Its settings (also `qodalis.config` of its package.json; code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    {
        key: 'file',
        label: 'JSON file',
        description: "The file the tree is kept in (relative paths from the plugin's data directory)",
        type: 'string',
        default: 'files.json',
        requiresRestart: true,
        validation: { required: true, max: 500 },
    },
    { key: 'readOnly', label: 'Read-only', description: 'Uploads, new folders and deletes are refused', type: 'boolean', default: true, requiresRestart: true },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    if (context.builder.fileStorageProvider) throw new Error('the filesystem storage is already set by the host or another plugin');
    const provider = await context.settings({
        title: 'Filesystem (JSON file)',
        description: 'A virtual file tree kept in one JSON file',
        settings,
    });
    const file = String(provider.value('settings', 'file') ?? 'files.json');
    const storage = new JsonFileStorageProvider({ filePath: isAbsolute(file) ? file : join(context.dataDir, file) });
    context.builder.setFileStorageProvider(provider.value('settings', 'readOnly') === false ? storage : readOnlyFileStorage(storage));
}
