import {
    CliConfigConflictError,
    applyCliConfigChanges,
    qcliTableName,
    type CliConfigSource,
    type CliConfigStoredSection,
    type CliConfigValue,
    type CliTableNameOptions,
    type ICliConfigStore,
} from '@qodalis/cli-server-abstractions';
import type { CliSqlConnection, CliSqlDialect, CliSqlSession } from './connection';
import { quoteIdent, quoteTable, tableExists, TRANSACTION } from './dialects';
import { CliMigrationRunner } from './runner';
import { codeSource, type CliMigrationSource } from './sources';

/** Options of {@link CliDatabaseConfigStore}. */
export interface CliDatabaseConfigStoreOptions extends Pick<CliTableNameOptions, 'tablePrefix' | 'schema'> {
    /** The database (`postgresConnection(pool)`, `mysqlConnection`, `mssqlConnection`, `sqliteConnection`). */
    connection: CliSqlConnection;
    /** The table's name (default `QcliConfig`: the prefix and per-table override follow the plugin table names). */
    tables?: { Config?: string };
}

const COLUMN_TYPES: Record<CliSqlDialect, { key: string; long: string; time: string; int: string }> = {
    postgres: { key: 'varchar(150)', long: 'text', time: 'timestamptz', int: 'integer' },
    mysql: { key: 'varchar(150)', long: 'longtext', time: 'datetime(3)', int: 'int' },
    mssql: { key: 'nvarchar(150)', long: 'nvarchar(max)', time: 'datetime2', int: 'int' },
    sqlite: { key: 'TEXT', long: 'TEXT', time: 'TEXT', int: 'INTEGER' },
};

/** The config table's schema as migrations (source `qcli-config`): one row per provider section. */
export function configStoreMigrations(table: string, schema?: string): CliMigrationSource {
    return codeSource('qcli-config', [
        {
            id: '1',
            name: 'config table',
            up: async (db) => {
                if (await tableExists(db, table, schema)) return;
                const d = db.dialect;
                const t = COLUMN_TYPES[d];
                const q = (name: string) => quoteIdent(d, name);
                await db.exec(
                    `CREATE TABLE ${quoteTable(d, table, schema)} (${[
                        `${q('Provider')} ${t.key} NOT NULL`,
                        `${q('Section')} ${t.key} NOT NULL`,
                        `${q('Version')} ${t.int} NOT NULL`,
                        `${q('Data')} ${t.long} NOT NULL`,
                        `${q('UpdatedAt')} ${t.time} NOT NULL`,
                        `CONSTRAINT ${q(`PK_${table}`)} PRIMARY KEY (${q('Provider')}, ${q('Section')})`,
                    ].join(', ')})`,
                );
            },
        },
    ]);
}

/**
 * Keeps writable settings in a database table (`QcliConfig`, source `database`): one row per
 * provider section holding its values as JSON and its version. A change runs in a transaction
 * with the row locked, so two servers sharing the database never lose a change and a stale
 * version is refused. The table is created by the migration source `qcli-config`, applied
 * when the store is created (`ready`); add `migrationSource` to the databases plugin to see it there.
 *
 * @example
 * ```ts
 * const store = new CliDatabaseConfigStore({ connection: postgresConnection(pool) });
 * await store.ready;
 * createCliServer({ config: { store } });
 * ```
 */
export class CliDatabaseConfigStore implements ICliConfigStore {
    readonly source: CliConfigSource = 'database';
    /** Resolves once the table exists; every read and write waits for it. */
    readonly ready: Promise<void>;
    /** The table's migrations, to show them in the databases plugin (`addSource`). */
    readonly migrationSource: CliMigrationSource;
    readonly connection: CliSqlConnection;
    private readonly table: string;
    private readonly schema?: string;

    constructor(options: CliDatabaseConfigStoreOptions) {
        this.connection = options.connection;
        this.schema = options.schema;
        const name = qcliTableName('Config', { tablePrefix: options.tablePrefix, tables: options.tables, schema: options.schema });
        this.table = name;
        this.migrationSource = configStoreMigrations(name, options.schema);
        const runner = new CliMigrationRunner('config', { connection: options.connection, tablePrefix: options.tablePrefix, schema: options.schema }).addSource(
            this.migrationSource,
        );
        this.ready = runner.up({ trigger: 'startup', wait: true }).then((run) => {
            if ('status' in run && run.status === 'failed') throw new Error(`config store schema: ${run.error}`);
        });
        this.ready.catch(() => undefined);
    }

    private sql(dialect: CliSqlDialect) {
        const q = (name: string) => quoteIdent(dialect, name);
        const table = quoteTable(dialect, this.table, this.schema);
        return { q, table };
    }

    private parse(row: { Version: unknown; Data: unknown } | undefined): CliConfigStoredSection {
        if (!row) return { values: {}, version: 0 };
        let values: Record<string, CliConfigValue> = {};
        try {
            const parsed = JSON.parse(String(row.Data));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed as Record<string, CliConfigValue>;
        } catch {
            values = {};
        }
        return { values, version: Number(row.Version) || 0 };
    }

    async read(provider: string, section: string): Promise<CliConfigStoredSection> {
        await this.ready;
        return this.connection.session(async (db) => {
            const { q, table } = this.sql(db.dialect);
            const rows = await db.query<{ Version: unknown; Data: unknown }>(
                `SELECT ${q('Version')} AS ${q('Version')}, ${q('Data')} AS ${q('Data')} FROM ${table} WHERE ${q('Provider')} = ? AND ${q('Section')} = ?`,
                [provider, section],
            );
            return this.parse(rows[0]);
        });
    }

    async write(
        provider: string,
        section: string,
        changes: Record<string, CliConfigValue | null>,
        expectedVersion?: number,
    ): Promise<CliConfigStoredSection> {
        await this.ready;
        // A first write of a section may race another server's insert (primary key): read again and retry once
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.connection.session((db) => this.writeOn(db, provider, section, changes, expectedVersion));
            } catch (err) {
                if (attempt > 0 || err instanceof CliConfigConflictError) throw err;
            }
        }
    }

    private async writeOn(
        db: CliSqlSession,
        provider: string,
        section: string,
        changes: Record<string, CliConfigValue | null>,
        expectedVersion: number | undefined,
    ): Promise<CliConfigStoredSection> {
        const d = db.dialect;
        const { q, table } = this.sql(d);
        const tx = TRANSACTION[d];
        await db.exec(tx.begin);
        try {
            const lock = d === 'postgres' || d === 'mysql' ? ' FOR UPDATE' : '';
            const hint = d === 'mssql' ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
            const rows = await db.query<{ Version: unknown; Data: unknown }>(
                `SELECT ${q('Version')} AS ${q('Version')}, ${q('Data')} AS ${q('Data')} FROM ${table}${hint} WHERE ${q('Provider')} = ? AND ${q('Section')} = ?${lock}`,
                [provider, section],
            );
            const current = this.parse(rows[0]);
            if (expectedVersion !== undefined && expectedVersion !== current.version) {
                throw new CliConfigConflictError(String(current.version));
            }
            const next: CliConfigStoredSection = { values: applyCliConfigChanges(current.values, changes), version: current.version + 1 };
            const data = JSON.stringify(next.values);
            const now = new Date();
            if (rows[0]) {
                await db.query(
                    `UPDATE ${table} SET ${q('Version')} = ?, ${q('Data')} = ?, ${q('UpdatedAt')} = ? WHERE ${q('Provider')} = ? AND ${q('Section')} = ?`,
                    [next.version, data, now, provider, section],
                );
            } else {
                await db.query(
                    `INSERT INTO ${table} (${q('Provider')}, ${q('Section')}, ${q('Version')}, ${q('Data')}, ${q('UpdatedAt')}) VALUES (?, ?, ?, ?, ?)`,
                    [provider, section, next.version, data, now],
                );
            }
            await db.exec(tx.commit);
            return next;
        } catch (err) {
            await db.exec(tx.rollback).catch(() => undefined);
            throw err;
        }
    }
}
