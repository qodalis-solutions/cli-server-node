/**
 * The entry point of the jobs plugin installed at runtime (`qodalis.entry`): the job scheduler, its API
 * (`/api/v1/qcli/jobs`), the `jobs_*` MCP tools and the dashboard's Jobs page. Its settings are its own `jobs` config
 * provider (run history retention). Jobs come from other plugins and the host's code; in memory (runs are lost on a
 * restart: a storage provider needs the host's code).
 */
import type { CliPluginContext, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliJobsBuilder } from './cli-jobs-builder';

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    return new CliJobsBuilder().build(context.eventBus);
}
