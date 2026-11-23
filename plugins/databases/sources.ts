import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { CliSqlDialect, CliSqlSession } from './connection';

/** A migration step: SQL, SQL per dialect, or code given the session. */
export type CliMigrationStep = string | Partial<Record<CliSqlDialect, string>> | ((db: CliSqlSession) => Promise<void>);

/** One schema change. Released migrations are never edited or reordered: add a new one instead. */
export interface CliMigration {
    /** Unique within its source, sortable: `0001`, `2`, `20261120111649`. */
    id: string;
    /** Shown in the dashboard: `create users`. */
    name: string;
    up: CliMigrationStep;
    /** Undoes `up`; without it the migration cannot be rolled back. */
    down?: CliMigrationStep;
    /** Run inside a transaction with its history row (default true; false for `CREATE INDEX CONCURRENTLY`). */
    transaction?: boolean;
}

/** Where a database's migrations come from (a folder of SQL files, code, ...). */
export interface CliMigrationSource {
    /** Unique per database: `app`, `qcli-users`. Stored with every applied migration. */
    readonly name: string;
    /** The migrations, in any order (the runner sorts them by id). */
    load(): Promise<CliMigration[]>;
}

/** Ids compared as numbers where they are numbers (`2` before `10`), else as text. */
export function compareIds(a: string, b: string): number {
    return a.localeCompare(b, 'en', { numeric: true });
}

/** The SQL a step runs on `dialect`, or null for a code step; throws when the step has none for the dialect. */
export function stepSql(step: CliMigrationStep, dialect: CliSqlDialect, migration: string): string | null {
    if (typeof step === 'function') return null;
    if (typeof step === 'string') return step;
    const sql = step[dialect];
    if (sql === undefined) throw new Error(`migration ${migration} has no SQL for ${dialect}`);
    return sql;
}

/** SHA-256 of the up step's SQL for the dialect; null for code (it cannot be compared reliably). */
export function checksumOf(migration: CliMigration, dialect: CliSqlDialect): string | null {
    const sql = stepSql(migration.up, dialect, migration.id);
    return sql === null ? null : createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

const NO_TRANSACTION = /^\s*--\s*qcli:no-transaction\b/i;
const FILE = /^([0-9A-Za-z]+)_(.+?)\.(up|down)\.sql$/;

/**
 * Migrations from a folder: `NNNN_name.up.sql`, with an optional `NNNN_name.down.sql`. A file starting with
 * `-- qcli:no-transaction` runs outside a transaction. Read again on every load, so a new file shows as pending.
 */
export function sqlFolderSource(directory: string, name = 'app'): CliMigrationSource {
    return {
        name,
        async load() {
            const files = (await fs.readdir(directory)).filter((f) => FILE.test(f));
            const byId = new Map<string, { name: string; up?: string; down?: string }>();
            for (const file of files) {
                const [, id, title, direction] = FILE.exec(file)!;
                const entry = byId.get(id) ?? { name: title.replace(/[_-]+/g, ' ') };
                if (entry.name !== title.replace(/[_-]+/g, ' ')) throw new Error(`migration ${id} has files with different names in ${directory}`);
                entry[direction as 'up' | 'down'] = await fs.readFile(join(directory, file), 'utf8');
                byId.set(id, entry);
            }
            return [...byId.entries()].map(([id, entry]) => {
                if (entry.up === undefined) throw new Error(`migration ${id} has a down file but no up file in ${directory}`);
                return {
                    id,
                    name: entry.name,
                    up: entry.up,
                    ...(entry.down !== undefined ? { down: entry.down } : {}),
                    transaction: !NO_TRANSACTION.test(entry.up),
                };
            });
        },
    };
}

/** Migrations given in code (how plugins ship their schema). */
export function codeSource(name: string, migrations: readonly CliMigration[]): CliMigrationSource {
    return { name, load: async () => migrations.map((m) => ({ ...m, id: String(m.id) })) };
}
