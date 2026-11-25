/**
 * The entry point of the MongoDB data explorer source installed at runtime (`qodalis.entry`): one source of the
 * data explorer (`/api/qcli/data-explorer`, the dashboard's Data explorer page, the `data_*` MCP tools), its
 * connection as settings (the connection string a `secret` setting: kept server-side, never returned). Read-only
 * by default. Nothing is added until it is configured (then a restart).
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult, DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';
import { MongoDataExplorerProvider } from './mongo-data-explorer-provider';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'data-explorer-mongo', package: '@qodalis/cli-server-plugin-data-explorer-mongo', title: 'Data explorer: MongoDB', icon: '🍃' };

/** Loads after the data explorer's own entry (`CLI_PLUGIN_LOAD_ORDER.SOURCE`). */
export const order = 70;

/** Its settings (also `qodalis.config` of its package.json; code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'name', label: 'Source name', description: 'Shown in the data explorer', type: 'string', default: 'mongo', requiresRestart: true, validation: { required: true, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' } },
    { key: 'description', label: 'Description', type: 'string', default: 'MongoDB database', requiresRestart: true },
    { key: 'connectionString', label: 'Connection string', description: 'e.g. mongodb://user:password@host:27017 (kept as a secret, never returned)', type: 'secret', required: true, requiresRestart: true },
    { key: 'database', label: 'Database', description: "The database queried", type: 'string', required: true, default: '', requiresRestart: true },
    { key: 'readOnly', label: 'Read-only', description: 'Queries may only read', type: 'boolean', default: true, requiresRestart: true },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 30000, requiresRestart: true, validation: { min: 1000, max: 600000 } },
    { key: 'maxRows', label: 'Rows at most', type: 'number', default: 1000, requiresRestart: true, validation: { min: 1, max: 100000 } },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({
        title: 'Data explorer: MongoDB',
        description: 'A MongoDB source of the data explorer',
        settings,
    });
    const text = (key: string) => String(provider.value('settings', key) ?? '').trim();
    const secret = text;
    if (!secret('connectionString') || !text('database')) {
        return context.needsConfiguration(provider.missingRequired());
    }
    context.builder.addDataExplorerProvider(new MongoDataExplorerProvider({ connectionString: secret('connectionString'), database: text('database') }), {
        name: text('name') || 'mongo',
        description: text('description') || 'MongoDB database',
        language: 'json' as DataExplorerLanguage,
        defaultOutputFormat: 'json' as DataExplorerOutputFormat,
        readOnly: provider.value('settings', 'readOnly') !== false,
        timeout: Number(provider.value('settings', 'timeoutMs') ?? 30000),
        maxRows: Number(provider.value('settings', 'maxRows') ?? 1000),
    });
}
