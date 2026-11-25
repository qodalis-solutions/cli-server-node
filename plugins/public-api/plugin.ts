/**
 * The entry point of the public-api plugin (`qodalis.entry`, `builder.addPlugin`): the host's public API with host
 * tokens, per-account quotas and usage, and its OpenAPI document with Swagger UI at `basePath`. It builds on the users
 * plugin (the `users` service: added in code, mounted, or installed from the marketplace); without it it is
 * `needs-configuration`. The quota from its settings applies to every account (`quota`, a function, from code
 * only, wins); the host's routes take the guard from the `public-api` service
 * (`builder.pluginServices.get('public-api').guard('rates:read')`).
 */
import { isAbsolute, join } from 'path';
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliPublicApiBuilder, DEFAULT_PUBLIC_API_BASE_PATH, DEFAULT_PUBLIC_API_TITLE, DEFAULT_USAGE_RETENTION_DAYS, type PublicApiUsers } from './cli-public-api-builder';
import type { PublicApiQuotaResolver } from './quota';
import type { IPublicApiUsageStore } from './usage-store';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'public-api', package: '@qodalis/cli-server-plugin-public-api', title: 'Public API', icon: '🌐' };

/** Its settings (code options of the same keys are their defaults; `quota`, `usageStore` and `openApi` as an object from code only). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'basePath', label: 'Path', description: 'Where the OpenAPI document and Swagger UI are served', type: 'string', default: DEFAULT_PUBLIC_API_BASE_PATH, requiresRestart: true, validation: { required: true, pattern: '^(/[A-Za-z0-9._~-]+)+$' } },
    { key: 'title', label: 'Title', type: 'string', default: DEFAULT_PUBLIC_API_TITLE, requiresRestart: true, validation: { required: true, max: 100 } },
    { key: 'openApiFile', label: 'OpenAPI document', description: "A JSON file (relative paths from the plugin's data directory); empty: an empty document", type: 'string', default: '', requiresRestart: true, validation: { max: 500 } },
    { key: 'serverUrl', label: 'Server URL', description: "The document's servers URL; empty: the request's", type: 'string', default: '', requiresRestart: true, validation: { pattern: '^(|https?://\\S+)$' } },
    { key: 'requestsPerDay', label: 'Requests per day', description: 'Per account; 0: unlimited', type: 'number', default: 0, requiresRestart: true, validation: { min: 0 } },
    { key: 'requestsPerMinute', label: 'Requests per minute', description: 'Per account; 0: unlimited', type: 'number', default: 0, requiresRestart: true, validation: { min: 0 } },
    { key: 'usageRetentionDays', label: 'Usage kept (days)', type: 'number', default: DEFAULT_USAGE_RETENTION_DAYS, requiresRestart: true, validation: { min: 1, max: 3650 } },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({ title: 'Public API', description: "The host's public API: tokens, quotas, its document", settings });
    const users = (context.options.users as PublicApiUsers | undefined) ?? context.services.get<PublicApiUsers>('users');
    if (!users) return context.needsConfiguration('the users plugin (install users, or add it before public-api)');
    const text = (key: string) => String(provider.value('settings', key) ?? '').trim();
    const num = (key: string) => Number(provider.value('settings', key) ?? 0) || 0;
    const builder = new CliPublicApiBuilder()
        .setUsers(users)
        .setBasePath(text('basePath') || DEFAULT_PUBLIC_API_BASE_PATH)
        .setTitle(text('title') || DEFAULT_PUBLIC_API_TITLE)
        .setUsageRetentionDays(Math.max(1, Math.floor(num('usageRetentionDays') || DEFAULT_USAGE_RETENTION_DAYS)));
    const openApi = context.options.openApi;
    if (openApi && typeof openApi === 'object') builder.setOpenApi(openApi);
    else if (text('openApiFile')) builder.setOpenApi(isAbsolute(text('openApiFile')) ? text('openApiFile') : join(context.dataDir, text('openApiFile')));
    if (text('serverUrl')) builder.setServerUrl(text('serverUrl'));
    const quota = context.options.quota as PublicApiQuotaResolver | undefined;
    const perDay = num('requestsPerDay');
    const perMinute = num('requestsPerMinute');
    if (typeof quota === 'function') builder.setQuota(quota);
    else if (perDay > 0 || perMinute > 0) builder.setQuota(() => ({ requestsPerDay: perDay > 0 ? perDay : null, requestsPerMinute: perMinute > 0 ? perMinute : null }));
    const usageStore = context.options.usageStore as IPublicApiUsageStore | undefined;
    if (usageStore) builder.setUsageStore(usageStore);
    const result = builder.build();
    context.services.set('public-api', result);
    return result;
}
