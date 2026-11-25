/**
 * The entry point of the audit plugin installed at runtime (`qodalis.entry`): the audit log (`/api/v1/qcli/audit`)
 * and the dashboard's Audit page, kept in memory (its size a setting). On a server protected by the users plugin the
 * host already has it (the users plugin brings it): the installed copy is then skipped.
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliAuditBuilder } from './cli-audit-builder';
import { DEFAULT_MAX_AUDIT_ENTRIES, InMemoryAuditStore } from './in-memory-audit-store';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'audit', package: '@qodalis/cli-server-plugin-audit', title: 'Audit', icon: '📋' };

/** Its settings (also `qodalis.config` of its package.json; code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'maxEntries', label: 'Entries kept', description: 'The oldest are dropped beyond it', type: 'number', default: DEFAULT_MAX_AUDIT_ENTRIES, requiresRestart: true, validation: { min: 100, max: 1_000_000 } },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({
        title: 'Audit',
        description: 'The audit log, kept in memory',
        settings,
    });
    const max = Number(provider.value('settings', 'maxEntries') ?? DEFAULT_MAX_AUDIT_ENTRIES);
    return new CliAuditBuilder().setStore(new InMemoryAuditStore(max)).build();
}
