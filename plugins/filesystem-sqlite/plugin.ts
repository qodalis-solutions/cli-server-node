/**
 * The entry point of the SQLite file storage (`qodalis.entry`, `builder.addPlugin`): the filesystem API over a file
 * tree kept in a SQLite database (default `<dataDir>/plugin-data/filesystem-sqlite/files.db`), its schema versioned
 * with the databases plugin's migrations. Read-only unless `readOnly` is turned off. Refused when the host (or another
 * plugin) already set the filesystem storage.
 */
import { isAbsolute, join } from 'path';
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { readOnlyFileStorage } from '@qodalis/cli-server-plugin-filesystem';
import { SqliteFileStorageProvider } from './sqlite-provider';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'filesystem-sqlite', package: '@qodalis/cli-server-plugin-filesystem-sqlite', title: 'Filesystem SQLite', icon: '🗃️' };

/** Its settings (code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'dbPath', label: 'Database file', description: "The SQLite file (relative paths from the plugin's data directory; :memory: for none)", type: 'string', default: 'files.db', requiresRestart: true, validation: { required: true, max: 500 } },
    { key: 'tablePrefix', label: 'Table prefix', description: 'Prepended to the table name (default Qcli)', type: 'string', default: 'Qcli', requiresRestart: true, validation: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } },
    { key: 'readOnly', label: 'Read-only', description: 'Uploads, new folders and deletes are refused', type: 'boolean', default: false, requiresRestart: true },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    if (context.builder.fileStorageProvider) throw new Error('the filesystem storage is already set by the host or another plugin');
    const provider = await context.settings({ title: 'Filesystem (SQLite)', description: 'A file tree kept in a SQLite database', settings });
    const text = (key: string) => String(provider.value('settings', key) ?? '').trim();
    const file = text('dbPath') || 'files.db';
    const storage = new SqliteFileStorageProvider({
        dbPath: file === ':memory:' || isAbsolute(file) ? file : join(context.dataDir, file),
        ...(text('tablePrefix') ? { tablePrefix: text('tablePrefix') } : {}),
    });
    await storage.ready;
    context.builder.setFileStorageProvider(provider.value('settings', 'readOnly') === true ? readOnlyFileStorage(storage) : storage);
    return undefined;
}
