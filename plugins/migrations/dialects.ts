import { isSqlIdentifier } from '@qodalis/cli-server-abstractions';
import type { CliSqlDialect, CliSqlSession } from './connection';

function checked(name: string): string {
    if (!isSqlIdentifier(name)) throw new Error(`invalid identifier: ${name}`);
    return name;
}

/** An identifier quoted for the dialect (validated first, so a name can never inject SQL). */
export function quoteIdent(dialect: CliSqlDialect, name: string): string {
    const n = checked(name);
    if (dialect === 'mysql') return `\`${n}\``;
    if (dialect === 'mssql') return `[${n}]`;
    return `"${n}"`;
}

/** A table name with its schema, quoted (`"qcli"."QcliFiles"`); SQLite and MySQL have no schemas here. */
export function quoteTable(dialect: CliSqlDialect, table: string, schema?: string): string {
    const t = quoteIdent(dialect, table);
    return schema && (dialect === 'postgres' || dialect === 'mssql') ? `${quoteIdent(dialect, schema)}.${t}` : t;
}

/** Column types the history tables use, by dialect. */
const TYPES: Record<CliSqlDialect, { key: string; text: string; long: string; time: string; int: string }> = {
    postgres: { key: 'varchar(150)', text: 'varchar(255)', long: 'text', time: 'timestamptz', int: 'integer' },
    mysql: { key: 'varchar(150)', text: 'varchar(255)', long: 'longtext', time: 'datetime(3)', int: 'int' },
    mssql: { key: 'nvarchar(150)', text: 'nvarchar(255)', long: 'nvarchar(max)', time: 'datetime2', int: 'int' },
    sqlite: { key: 'TEXT', text: 'TEXT', long: 'TEXT', time: 'TEXT', int: 'INTEGER' },
};

export interface HistoryTables {
    migrations: string;
    runs: string;
}

/** Creates the history tables when missing (`QcliMigrations`, `QcliMigrationRuns`). */
export async function ensureHistoryTables(db: CliSqlSession, tables: HistoryTables, schema?: string): Promise<void> {
    const d = db.dialect;
    const t = TYPES[d];
    const q = (name: string) => quoteIdent(d, name);
    const create = async (table: string, columns: string) => {
        if (await tableExists(db, table, schema)) return;
        await db.exec(`CREATE TABLE ${quoteTable(d, table, schema)} (${columns})`);
    };
    await create(
        tables.migrations,
        [
            `${q('Source')} ${t.key} NOT NULL`,
            `${q('Id')} ${t.key} NOT NULL`,
            `${q('Name')} ${t.text} NOT NULL`,
            `${q('Checksum')} ${t.key} NULL`,
            `${q('AppliedAt')} ${t.time} NOT NULL`,
            `${q('DurationMs')} ${t.int} NOT NULL`,
            `${q('AppliedBy')} ${t.text} NULL`,
            `${q('RunId')} ${t.key} NULL`,
            `CONSTRAINT ${q(`PK_${tables.migrations}`)} PRIMARY KEY (${q('Source')}, ${q('Id')})`,
        ].join(', '),
    );
    await create(
        tables.runs,
        [
            `${q('Id')} ${t.key} NOT NULL`,
            `${q('Direction')} ${t.key} NOT NULL`,
            `${q('Target')} ${t.key} NULL`,
            `${q('Trigger')} ${t.key} NOT NULL`,
            `${q('Actor')} ${t.text} NULL`,
            `${q('StartedAt')} ${t.time} NOT NULL`,
            `${q('FinishedAt')} ${t.time} NULL`,
            `${q('Status')} ${t.key} NOT NULL`,
            `${q('Error')} ${t.long} NULL`,
            `${q('Applied')} ${t.long} NULL`,
            `CONSTRAINT ${q(`PK_${tables.runs}`)} PRIMARY KEY (${q('Id')})`,
        ].join(', '),
    );
}

/** True when the table exists (in `schema`, or the connection's default schema). */
export async function tableExists(db: CliSqlSession, table: string, schema?: string): Promise<boolean> {
    checked(table);
    switch (db.dialect) {
        case 'postgres':
            return (
                (await db.query(
                    'SELECT 1 FROM information_schema.tables WHERE table_name = ? AND table_schema = COALESCE(?, current_schema())',
                    [table, schema ?? null],
                )).length > 0
            );
        case 'mysql':
            return (await db.query('SELECT 1 FROM information_schema.tables WHERE table_name = ? AND table_schema = DATABASE()', [table])).length > 0;
        case 'mssql':
            return (
                (await db.query('SELECT 1 AS x FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ? AND TABLE_SCHEMA = COALESCE(?, SCHEMA_NAME())', [
                    table,
                    schema ?? null,
                ])).length > 0
            );
        case 'sqlite':
            return (await db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table])).length > 0;
    }
}

/** True when the table has the column. */
export async function columnExists(db: CliSqlSession, table: string, column: string, schema?: string): Promise<boolean> {
    checked(table);
    checked(column);
    switch (db.dialect) {
        case 'postgres':
            return (
                (await db.query(
                    'SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ? AND table_schema = COALESCE(?, current_schema())',
                    [table, column, schema ?? null],
                )).length > 0
            );
        case 'mysql':
            return (
                (await db.query('SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ? AND table_schema = DATABASE()', [table, column]))
                    .length > 0
            );
        case 'mssql':
            return (
                (await db.query(
                    'SELECT 1 AS x FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ? AND TABLE_SCHEMA = COALESCE(?, SCHEMA_NAME())',
                    [table, column, schema ?? null],
                )).length > 0
            );
        case 'sqlite':
            return (await db.query<{ name: string }>(`PRAGMA table_info(${quoteIdent('sqlite', table)})`)).some((c) => c.name === column);
    }
}

/** Renames a table (in its schema). */
export async function renameTable(db: CliSqlSession, from: string, to: string, schema?: string): Promise<void> {
    const d = db.dialect;
    if (d === 'mssql') {
        const source = schema ? `${checked(schema)}.${checked(from)}` : checked(from);
        await db.query('EXEC sp_rename ?, ?', [source, checked(to)]);
    } else if (d === 'mysql') {
        await db.exec(`RENAME TABLE ${quoteIdent(d, from)} TO ${quoteIdent(d, to)}`);
    } else {
        await db.exec(`ALTER TABLE ${quoteTable(d, from, schema)} RENAME TO ${quoteIdent(d, to)}`);
    }
}

/** Renames a column (SQLite 3.25 and later). */
export async function renameColumn(db: CliSqlSession, table: string, from: string, to: string, schema?: string): Promise<void> {
    const d = db.dialect;
    if (d === 'mssql') {
        const source = `${schema ? `${checked(schema)}.` : ''}${checked(table)}.${checked(from)}`;
        await db.query("EXEC sp_rename ?, ?, 'COLUMN'", [source, checked(to)]);
    } else {
        await db.exec(`ALTER TABLE ${quoteTable(d, table, schema)} RENAME COLUMN ${quoteIdent(d, from)} TO ${quoteIdent(d, to)}`);
    }
}

/**
 * Moves a table of a previous release to its new name and columns (cli-server-dotnet#99): when `legacy` exists and
 * `table` does not, renames the table, then each column of `columns` (old → new) present under its old name.
 * Returns true when it renamed anything.
 */
export async function adoptLegacyTable(
    db: CliSqlSession,
    legacy: string,
    table: string,
    columns: Record<string, string> = {},
    schema?: string,
): Promise<boolean> {
    if (legacy === table || !(await tableExists(db, legacy, schema)) || (await tableExists(db, table, schema))) return false;
    await renameTable(db, legacy, table, schema);
    for (const [from, to] of Object.entries(columns)) {
        if (from !== to && (await columnExists(db, table, from, schema))) await renameColumn(db, table, from, to, schema);
    }
    return true;
}

/** Statements that open, commit and roll back a transaction. */
export const TRANSACTION: Record<CliSqlDialect, { begin: string; commit: string; rollback: string }> = {
    postgres: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
    mysql: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
    mssql: { begin: 'BEGIN TRANSACTION', commit: 'COMMIT TRANSACTION', rollback: 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION' },
    sqlite: { begin: 'BEGIN IMMEDIATE', commit: 'COMMIT', rollback: 'ROLLBACK' },
};

/**
 * Takes the database's migration lock on the session: waits for it (`wait`), or returns false at once when another
 * process holds it. SQLite has one writer per database file and no session locks: always true.
 */
export async function acquireLock(db: CliSqlSession, key: string, wait: boolean): Promise<boolean> {
    switch (db.dialect) {
        case 'postgres': {
            const fn = wait ? 'pg_advisory_lock' : 'pg_try_advisory_lock';
            const rows = await db.query<{ ok: boolean | null }>(`SELECT ${fn}(hashtext(?)) AS ok`, [key]);
            return wait || rows[0]?.ok === true;
        }
        case 'mysql': {
            const rows = await db.query<{ ok: number | null }>('SELECT GET_LOCK(?, ?) AS ok', [key, wait ? -1 : 0]);
            return Number(rows[0]?.ok) === 1;
        }
        case 'mssql': {
            const rows = await db.query<{ ok: number }>(
                "DECLARE @r int; EXEC @r = sp_getapplock @Resource = ?, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = ?; SELECT @r AS ok",
                [key, wait ? -1 : 0],
            );
            return Number(rows[0]?.ok) >= 0;
        }
        case 'sqlite':
            return true;
    }
}

/** Releases the lock {@link acquireLock} took. */
export async function releaseLock(db: CliSqlSession, key: string): Promise<void> {
    switch (db.dialect) {
        case 'postgres':
            await db.query('SELECT pg_advisory_unlock(hashtext(?))', [key]);
            return;
        case 'mysql':
            await db.query('SELECT RELEASE_LOCK(?)', [key]);
            return;
        case 'mssql':
            await db.query("EXEC sp_releaseapplock @Resource = ?, @LockOwner = 'Session'", [key]);
            return;
        case 'sqlite':
            return;
    }
}
