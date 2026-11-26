/**
 * The entry point of the config-redis plugin (`qodalis.entry`, `builder.addPlugin`): Redis becomes the server's
 * default config store (`CLI_PLUGIN_LOAD_ORDER.CONFIG_STORE`): the settings of the providers registered before it
 * move to Redis, those registered after it start there. Its own settings (the URL a secret) are kept in
 * `<dataDir>/plugin-settings.json`, never in Redis itself. Without a URL (or a `client` in code) it is
 * `needs-configuration` and the settings stay where they were.
 */
import { join } from 'path';
import { JsonFileConfigStore, type CliConfigSettingDefinition, type CliPluginContext, type CliPluginEntryInfo, type CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliRedisConfigStore, DEFAULT_REDIS_CONFIG_KEY_PREFIX, type CliRedisConfigClient } from './redis-config-store';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'config-redis', package: '@qodalis/cli-server-plugin-config-redis', title: 'Config on Redis', icon: '🟥' };

/** Before the providers resolve their store (`CLI_PLUGIN_LOAD_ORDER.CONFIG_STORE`). */
export const order = 20;

/** Its settings (code options of the same keys are their defaults; `client`, an ioredis client, is read from code only). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'url', label: 'Redis URL', description: 'redis://[:password@]host:6379/0 (rediss:// for TLS); kept as a secret, never returned', type: 'secret', required: true, requiresRestart: true },
    { key: 'keyPrefix', label: 'Key prefix', description: 'Prepended to every key: <prefix><provider>:<section>', type: 'string', default: DEFAULT_REDIS_CONFIG_KEY_PREFIX, requiresRestart: true, validation: { max: 200 } },
    { key: 'ttlSeconds', label: 'Expiry (seconds)', description: 'A section expires this long after its last change; 0: never', type: 'number', default: 0, requiresRestart: true, validation: { min: 0 } },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({
        title: 'Config on Redis',
        description: "Redis as the server's config store",
        settings,
        // Not in Redis: the URL must be read before Redis can be. The server's own store of the file (a second one
        // would cache the file too and lose the other plugins' writes); its own only on a server before it
        store: context.pluginSettingsStore ?? new JsonFileConfigStore(join(context.serverDataDir, 'plugin-settings.json')),
    });
    const client = context.options.client as CliRedisConfigClient | undefined;
    const url = String(provider.value('settings', 'url') ?? '').trim();
    if (!client && !url) return context.needsConfiguration(provider.missingRequired());
    if (typeof context.builder.replaceConfigStore !== 'function') throw new Error('this server cannot change its config store at runtime');
    const ttl = Number(provider.value('settings', 'ttlSeconds') ?? 0);
    const store = new CliRedisConfigStore({
        ...(client ? { client } : { url }),
        keyPrefix: String(provider.value('settings', 'keyPrefix') || DEFAULT_REDIS_CONFIG_KEY_PREFIX),
        ...(ttl > 0 ? { ttlSeconds: Math.floor(ttl) } : {}),
    });
    context.builder.replaceConfigStore(store);
    (context.restart as { onShutdown?(name: string, fn: () => unknown): void }).onShutdown?.('config-redis store', () => store.close());
    return undefined;
}
