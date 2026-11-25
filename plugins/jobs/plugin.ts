/**
 * The entry point of the jobs plugin installed at runtime (`qodalis.entry`): the job scheduler, its API
 * (`/api/v1/qcli/jobs`), the `jobs_*` MCP tools and the dashboard's Jobs page. Its settings are its own `jobs` config
 * provider (run history retention). Jobs come from other plugins and the host's code; in memory (runs are lost on a
 * restart: a storage provider needs the host's code).
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliJobsBuilder } from './cli-jobs-builder';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'jobs', package: '@qodalis/cli-server-plugin-jobs', title: 'Jobs', icon: '⏱️' };

/** No settings of its own here: the `jobs` config provider (run history retention) is the scheduler's. */
export const settings: CliConfigSettingDefinition[] = [];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    return new CliJobsBuilder().build(context.eventBus);
}
