/**
 * The entry point of the Elasticsearch data explorer source installed at runtime (`qodalis.entry`): one source of the
 * data explorer (`/api/qcli/data-explorer`, the dashboard's Data explorer page, the `data_*` MCP tools), its
 * connection as settings (the connection string a `secret` setting: kept server-side, never returned). Read-only
 * by default. Nothing is added until it is configured (then a restart).
 */
import type { CliPluginContext, CliPluginEntryResult, DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';
import { ElasticsearchDataExplorerProvider } from './elasticsearch-data-explorer-provider';

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const settings = await context.settings({
        title: 'Data explorer: Elasticsearch',
        description: 'A Elasticsearch source of the data explorer',
        settings: [
            { key: 'name', label: 'Source name', description: 'Shown in the data explorer', type: 'string', default: 'elasticsearch', requiresRestart: true, validation: { required: true, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' } },
            { key: 'description', label: 'Description', type: 'string', default: 'Elasticsearch database', requiresRestart: true },
            { key: 'node', label: 'Node URL', description: 'e.g. https://user:password@host:9200 (kept as a secret, never returned)', type: 'secret', requiresRestart: true },
            { key: 'readOnly', label: 'Read-only', description: 'Queries may only read', type: 'boolean', default: true, requiresRestart: true },
            { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 30000, requiresRestart: true, validation: { min: 1000, max: 600000 } },
            { key: 'maxRows', label: 'Rows at most', type: 'number', default: 1000, requiresRestart: true, validation: { min: 1, max: 100000 } },
        ],
    });
    const text = (key: string) => String(settings.value('settings', key) ?? '').trim();
    const secret = text;
    if (!secret('node')) {
        context.logger.warn('not configured: config set data-explorer-elasticsearch.settings.<key> <value> (node), then restart');
        return;
    }
    context.builder.addDataExplorerProvider(new ElasticsearchDataExplorerProvider({ node: secret('node') }), {
        name: text('name') || 'elasticsearch',
        description: text('description') || 'Elasticsearch database',
        language: 'elasticsearch' as DataExplorerLanguage,
        defaultOutputFormat: 'json' as DataExplorerOutputFormat,
        readOnly: settings.value('settings', 'readOnly') !== false,
        timeout: Number(settings.value('settings', 'timeoutMs') ?? 30000),
        maxRows: Number(settings.value('settings', 'maxRows') ?? 1000),
    });
}
