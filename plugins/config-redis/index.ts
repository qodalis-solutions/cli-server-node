export {
    CliRedisConfigStore,
    CliRedisConfigStoreOptions,
    CliRedisConfigClient,
    DEFAULT_REDIS_CONFIG_KEY_PREFIX,
    REDIS_CONFIG_WRITE_SCRIPT,
} from './redis-config-store';
export { configRedisInstalledPlugin } from './package-info';
/** The plugin's entry point (`builder.addPlugin(configRedisPluginEntry, options)`; what the marketplace loads). */
export * as configRedisPluginEntry from './plugin';
