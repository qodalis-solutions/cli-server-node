/**
 * The entry point of the SQL (SQLite, PostgreSQL, MySQL) data explorer source installed at runtime (`qodalis.entry`): one source of the
 * data explorer (`/api/qcli/data-explorer`, the dashboard's Data explorer page, the `data_*` MCP tools), its
 * connection as settings (the connection string a `secret` setting: kept server-side, never returned). Read-only
 * by default. Nothing is added until it is configured (then a restart).
 */
import { isAbsolute, join } from 'path';
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult, DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';
import { SqlDataExplorerProvider } from './sql-data-explorer-provider';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'data-explorer-sql', package: '@qodalis/cli-server-plugin-data-explorer-sql', title: 'Data explorer: SQL (SQLite, PostgreSQL, MySQL)', icon: '🧮' };

/** Loads after the data explorer's own entry (`CLI_PLUGIN_LOAD_ORDER.SOURCE`). */
export const order = 70;

/** Its settings (also `qodalis.config` of its package.json; code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'name', label: 'Source name', description: 'Shown in the data explorer', type: 'string', default: 'sql', requiresRestart: true, validation: { required: true, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' } },
    { key: 'description', label: 'Description', type: 'string', default: 'SQL (SQLite, PostgreSQL, MySQL) database', requiresRestart: true },
    { key: 'connectionString', label: 'Connection string', description: 'For postgres and mysql, e.g. postgres://user:password@host:5432/database (kept as a secret, never returned)', type: 'secret', requiresRestart: true },
    { key: 'type', label: 'Engine', description: "sqlite, postgres or mysql", type: 'enum', default: 'sqlite', validation: { options: ['sqlite', 'postgres', 'mysql'] }, requiresRestart: true },
    { key: 'filename', label: 'SQLite file', description: "The SQLite database file (relative paths from the plugin's data directory)", type: 'string', default: 'data.db', requiresRestart: true },
    { key: 'readOnly', label: 'Read-only', description: 'Queries may only read', type: 'boolean', default: true, requiresRestart: true },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 30000, requiresRestart: true, validation: { min: 1000, max: 600000 } },
    { key: 'maxRows', label: 'Rows at most', type: 'number', default: 1000, requiresRestart: true, validation: { min: 1, max: 100000 } },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({
        title: 'Data explorer: SQL (SQLite, PostgreSQL, MySQL)',
        description: 'A SQL (SQLite, PostgreSQL, MySQL) source of the data explorer',
        settings,
    });
    const text = (key: string) => String(provider.value('settings', key) ?? '').trim();
    const secret = text;
    const type = (text('type') || 'sqlite') as 'sqlite' | 'postgres' | 'mysql';
    if (type !== 'sqlite' && !secret('connectionString')) {
        return context.needsConfiguration(['settings.connectionString']);
    }
    context.builder.addDataExplorerProvider(new SqlDataExplorerProvider(type === 'sqlite' ? { type, filename: isAbsolute(text('filename')) ? text('filename') : join(context.dataDir, text('filename') || 'data.db') } : { type, connectionString: secret('connectionString') }), {
        name: text('name') || 'sql',
        description: text('description') || 'SQL (SQLite, PostgreSQL, MySQL) database',
        language: 'sql' as DataExplorerLanguage,
        defaultOutputFormat: 'table' as DataExplorerOutputFormat,
        readOnly: provider.value('settings', 'readOnly') !== false,
        timeout: Number(provider.value('settings', 'timeoutMs') ?? 30000),
        maxRows: Number(provider.value('settings', 'maxRows') ?? 1000),
    });
}
