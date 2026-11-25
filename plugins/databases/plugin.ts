/**
 * The entry point of the databases plugin (`qodalis.entry`, `builder.addPlugin`): one database from its settings
 * (dialect, connection a secret, migrations folder, apply on startup), shown with its size, load, largest tables and
 * migrations on the dashboard, in the terminal (`databases`), over MCP and at `/api/v1/qcli/databases`. It loads
 * before the plugins that use it (`CLI_PLUGIN_LOAD_ORDER.CORE`) and is shared as the `databases` service
 * (`CliDatabases`: filesystem-sqlite and others add theirs). In code, `configure(builder)` adds the host's own
 * databases (pools, migration sources) to the same plugin. The driver (`pg`, `mysql2`, `mssql`, `better-sqlite3`)
 * comes from the plugin's folder or the server's. Without a connection (or `configure`) it is `needs-configuration`.
 */
import { createRequire } from 'module';
import { isAbsolute, join } from 'path';
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult, ICliAuditStore } from '@qodalis/cli-server-abstractions';
import { CliDatabasesBuilder } from './builder';
import { mssqlConnection, mysqlConnection, postgresConnection, sqliteConnection, type CliSqlConnection, type CliSqlDialect } from './connection';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'databases', package: '@qodalis/cli-server-plugin-databases', title: 'Databases', icon: '🗄️' };

/** Before the plugins that keep their data in it (`CLI_PLUGIN_LOAD_ORDER.CORE`). */
export const order = 30;

/** Its settings (code options of the same keys are their defaults; `configure` and `auditStore` are read from code only). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'name', label: 'Name', description: 'The database in the API, the terminal and the dashboard', type: 'string', default: 'main', requiresRestart: true, validation: { required: true, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' } },
    { key: 'dialect', label: 'Dialect', type: 'enum', default: 'postgres', requiresRestart: true, validation: { options: ['postgres', 'mysql', 'mssql', 'sqlite'] } },
    { key: 'connectionString', label: 'Connection', description: 'A connection string (postgres://, mysql://, mssql: Server=...), or the SQLite file (relative: the plugin data folder); kept as a secret', type: 'secret', required: true, requiresRestart: true },
    { key: 'migrationsFolder', label: 'Migrations folder', description: 'NNNN_name.up.sql / .down.sql files (relative: the plugin data folder); empty: none', type: 'string', default: '', requiresRestart: true, validation: { max: 500 } },
    { key: 'applyOnStartup', label: 'Apply on startup', description: 'Pending migrations run when the server starts', type: 'boolean', default: false, requiresRestart: true },
];

/** A database driver: the plugin's own, else the server's (the working directory, the main module). */
export function requireDriver<T>(name: string): T {
    const attempts: Array<() => unknown> = [
        () => require(name),
        () => createRequire(join(process.cwd(), 'package.json'))(name),
        () => (require.main ? require.main.require(name) : undefined),
    ];
    for (const attempt of attempts) {
        try {
            const mod = attempt();
            if (mod) return mod as T;
        } catch {
            // the next place
        }
    }
    throw new Error(`the ${name} driver is not installed (npm install ${name} next to the server)`);
}

/** A connection from a dialect and its connection string (or SQLite file). */
export async function openConnection(dialect: CliSqlDialect, connection: string, dataDir: string): Promise<{ connection: CliSqlConnection; close: () => Promise<unknown> }> {
    switch (dialect) {
        case 'postgres': {
            const { Pool } = requireDriver<{ Pool: new (c: { connectionString: string }) => Parameters<typeof postgresConnection>[0] & { end(): Promise<void> } }>('pg');
            const pool = new Pool({ connectionString: connection });
            return { connection: postgresConnection(pool), close: () => pool.end() };
        }
        case 'mysql': {
            const mysql = requireDriver<{ createPool(uri: string): Parameters<typeof mysqlConnection>[0] & { end(): Promise<void> } }>('mysql2/promise');
            const pool = mysql.createPool(connection);
            return { connection: mysqlConnection(pool), close: () => pool.end() };
        }
        case 'mssql': {
            const mssql = requireDriver<{ ConnectionPool: new (c: string) => { connect(): Promise<Parameters<typeof mssqlConnection>[0] & { close(): Promise<void> }> } }>('mssql');
            const pool = await new mssql.ConnectionPool(connection).connect();
            return { connection: mssqlConnection(pool), close: () => pool.close() };
        }
        case 'sqlite': {
            const Database = requireDriver<new (file: string) => Parameters<typeof sqliteConnection>[0] & { close(): void }>('better-sqlite3');
            const db = new Database(isAbsolute(connection) || connection === ':memory:' ? connection : join(dataDir, connection));
            return { connection: sqliteConnection(db), close: async () => db.close() };
        }
        default:
            throw new Error(`unknown dialect: ${String(dialect)}`);
    }
}

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({ title: 'Databases', description: 'The database the databases plugin shows and migrates', settings });
    const text = (key: string) => String(provider.value('settings', key) ?? '').trim();
    const configure = context.options.configure as ((builder: CliDatabasesBuilder) => void) | undefined;
    const connectionString = text('connectionString');
    if (!connectionString && typeof configure !== 'function') return context.needsConfiguration(provider.missingRequired());

    const builder = new CliDatabasesBuilder();
    const auditStore = context.options.auditStore as ICliAuditStore | undefined;
    if (auditStore) builder.setAuditStore(auditStore);
    if (connectionString) {
        const dialect = (text('dialect') || 'postgres') as CliSqlDialect;
        const opened = await openConnection(dialect, connectionString, context.dataDir);
        (context.restart as { onShutdown?(name: string, fn: () => unknown): void }).onShutdown?.('databases connection', opened.close);
        const name = text('name') || 'main';
        builder.addDatabase(name, { connection: opened.connection, applyOnStartup: provider.value('settings', 'applyOnStartup') === true });
        const folder = text('migrationsFolder');
        if (folder) builder.addSqlFolder(name, isAbsolute(folder) ? folder : join(context.dataDir, folder));
    }
    if (typeof configure === 'function') configure(builder);
    const result = builder.build();
    await result.applyOnStartup();
    context.services.set('databases', result.databases);
    return result;
}
