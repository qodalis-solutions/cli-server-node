/**
 * Names of the tables CLI plugins create (cli-server-dotnet#99, cli-server-node#77): a common prefix (`Qcli`) and
 * PascalCase, so they stand apart from an application's own tables in a shared database. The same names and
 * options in the Node, .NET and Python servers.
 */

/** The prefix every plugin table gets unless told otherwise. */
export const DEFAULT_TABLE_PREFIX = 'Qcli';

/** How a plugin store names its tables. */
export interface CliTableNameOptions {
    /** Prefix of every table (default `Qcli`; `''` gives the plain PascalCase names). */
    tablePrefix?: string;
    /** Per-table names, by the table's base name (`{ Files: 'MyFiles' }`); win over the prefix. */
    tables?: Record<string, string>;
    /** Schema of the tables, where the database has schemas (PostgreSQL, SQL Server). */
    schema?: string;
    /** Keep the names of the previous releases (`files`, `qcli_users`, …) instead of migrating them. */
    legacyTableNames?: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** True for a name usable as a table, schema or column: letters, digits and `_`, not starting with a digit. */
export function isSqlIdentifier(name: unknown): name is string {
    return typeof name === 'string' && IDENTIFIER.test(name);
}

/**
 * The table name for a store's table `base` (PascalCase, e.g. `Files`, `JobExecutions`): the per-table override,
 * else the prefix + base, else (with `legacyTableNames`) `legacy`. Throws `invalid table name: <name>` for a name
 * that is not an identifier, so a configured name can never inject SQL.
 */
export function qcliTableName(base: string, options: CliTableNameOptions = {}, legacy?: string): string {
    const override = options.tables?.[base];
    const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
    const name = override ?? (options.legacyTableNames && legacy ? legacy : `${prefix}${base}`);
    if (!isSqlIdentifier(name)) throw new Error(`invalid table name: ${name}`);
    if (options.schema !== undefined && !isSqlIdentifier(options.schema)) throw new Error(`invalid schema name: ${options.schema}`);
    return name;
}
