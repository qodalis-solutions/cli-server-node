/**
 * The entry point of the users-postgres plugin (`qodalis.entry`, `builder.addPlugin`): the users plugin's stores
 * (users, groups, passwords, sessions, API tokens, audit log) in PostgreSQL. It loads before the users plugin
 * (`CLI_PLUGIN_LOAD_ORDER.AUTH - 5`), applies the schema migrations and shares the stores as the `users.stores`
 * service, which the users entry takes. Without a connection string (or a `pool` in code) it is
 * `needs-configuration` and the users plugin keeps its stores in memory.
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import type { Pool } from 'pg';
import { createPostgresUsersStores } from './postgres-users-stores';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'users-postgres', package: '@qodalis/cli-server-plugin-users-postgres', title: 'Users on PostgreSQL', icon: '🐘' };

/** Before the users plugin (`CLI_PLUGIN_LOAD_ORDER.AUTH - 5`), which takes its stores. */
export const order = 5;

/** The service the stores are shared as (the users entry reads it). */
export const USERS_STORES_SERVICE = 'users.stores';

/** Its settings (code options of the same keys are their defaults; `pool`, a pg Pool, is read from code only). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'connectionString', label: 'Connection string', description: 'postgres://user:password@host:5432/database (kept as a secret, never returned)', type: 'secret', required: true, requiresRestart: true },
    { key: 'schema', label: 'Schema', description: 'The schema of the tables; empty: the search path', type: 'string', default: '', requiresRestart: true, validation: { pattern: '^([A-Za-z_][A-Za-z0-9_]*)?$' } },
    { key: 'tablePrefix', label: 'Table prefix', description: 'Prepended to the table names (default Qcli)', type: 'string', default: 'Qcli', requiresRestart: true, validation: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({ title: 'Users on PostgreSQL', description: "The users plugin's stores in PostgreSQL", settings });
    const pool = context.options.pool as Pool | undefined;
    const connectionString = String(provider.value('settings', 'connectionString') ?? '').trim();
    if (!pool && !connectionString) return context.needsConfiguration(provider.missingRequired());
    const schema = String(provider.value('settings', 'schema') ?? '').trim();
    const tablePrefix = String(provider.value('settings', 'tablePrefix') ?? '').trim();
    const stores = createPostgresUsersStores(pool ?? connectionString, { ...(schema ? { schema } : {}), ...(tablePrefix ? { tablePrefix } : {}) });
    try {
        await stores.init();
    } catch (err) {
        await stores.close().catch(() => undefined);
        throw err;
    }
    (context.restart as { onShutdown?(name: string, fn: () => unknown): void }).onShutdown?.('users-postgres pool', () => stores.close());
    context.services.set(USERS_STORES_SERVICE, stores);
    if (context.builder.installedPlugins.some((p) => p.id === '@qodalis/cli-server-plugin-users')) {
        context.logger.warn('the users plugin was set up before its stores: add users-postgres with builder.addPlugin, or pass the stores to CliUsersBuilder');
    }
    return undefined;
}
