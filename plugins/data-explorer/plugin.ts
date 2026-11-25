/**
 * The entry point of the data explorer (`qodalis.entry`, `builder.addPlugin`). The data explorer itself is part of
 * the server (its API, the dashboard's page and the `data_*` MCP tools are served once a source is added); this entry
 * sets the rules every source added after it follows (`CLI_PLUGIN_LOAD_ORDER.CORE`, before the sources at `SOURCE`):
 * read-only for all, a row cap, a rate limit for sources without their own. Shared as the `data-explorer.policy`
 * service, which the server's `addDataExplorerProvider` applies.
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'data-explorer', package: '@qodalis/cli-server-plugin-data-explorer', title: 'Data explorer', icon: '🔍' };

/** Before its sources (`CLI_PLUGIN_LOAD_ORDER.CORE`). */
export const order = 30;

/** The service the rules are shared as (read by the server when a source is added). */
export const DATA_EXPLORER_POLICY_SERVICE = 'data-explorer.policy';

/** Its settings (code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'forceReadOnly', label: 'Read-only for all', description: 'Every source may only read, whatever its own setting', type: 'boolean', default: false, requiresRestart: true },
    { key: 'maxRows', label: 'Rows at most', description: 'The most rows any source returns; 0: each source its own', type: 'number', default: 0, requiresRestart: true, validation: { min: 0, max: 1_000_000 } },
    { key: 'rateLimitQueries', label: 'Queries per window', description: 'Per caller and source, for sources without their own limit; 0: none', type: 'number', default: 0, requiresRestart: true, validation: { min: 0 } },
    { key: 'rateLimitWindowSeconds', label: 'Window (seconds)', type: 'number', default: 60, requiresRestart: true, validation: { min: 1, max: 86400 } },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({ title: 'Data explorer', description: 'Rules every data explorer source follows', settings });
    const num = (key: string) => Number(provider.value('settings', key) ?? 0) || 0;
    const queries = Math.floor(num('rateLimitQueries'));
    context.services.set(DATA_EXPLORER_POLICY_SERVICE, {
        forceReadOnly: provider.value('settings', 'forceReadOnly') === true,
        maxRows: Math.floor(num('maxRows')),
        ...(queries > 0 ? { rateLimit: { maxQueries: queries, windowSeconds: Math.max(1, Math.floor(num('rateLimitWindowSeconds') || 60)) } } : {}),
    });
    return undefined;
}
