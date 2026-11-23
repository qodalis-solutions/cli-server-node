import type { Pool } from 'pg';

/** One schema change. `id`s are applied in ascending order and never edited once released. */
export interface PostgresMigration {
    /** Unique and increasing, e.g. 1, 2, 3. */
    id: number;
    /** Shown in the history table, e.g. `create users`. */
    name: string;
    /** SQL run in one transaction. */
    up: string;
}

/**
 * Applies the migrations not yet recorded in `historyTable`, in order, each in its own
 * transaction, under an advisory lock so servers starting together never apply one twice
 * (the counterpart of EF Core's `__EFMigrationsHistory`). Returns the ids applied now.
 *
 * Release rules: never change or reorder a released migration; add a new one instead.
 */
export async function runPostgresMigrations(pool: Pool, historyTable: string, migrations: readonly PostgresMigration[]): Promise<number[]> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(historyTable)) throw new Error(`invalid migrations table: ${historyTable}`);
    const sorted = [...migrations].sort((a, b) => a.id - b.id);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].id === sorted[i - 1].id) throw new Error(`duplicate migration id ${sorted[i].id} in ${historyTable}`);
    }

    const client = await pool.connect();
    const applied: number[] = [];
    try {
        // the session lock covers the whole run; each migration still commits on its own
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [historyTable]);
        try {
            await client.query(
                `CREATE TABLE IF NOT EXISTS ${historyTable} (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
            );
            const { rows } = await client.query<{ id: number }>(`SELECT id FROM ${historyTable}`);
            const done = new Set(rows.map((r) => Number(r.id)));
            const known = new Set(sorted.map((m) => m.id));
            const unknown = [...done].filter((id) => !known.has(id));
            if (unknown.length > 0) {
                // the database was migrated by a newer version: refuse rather than run on a schema we do not know
                throw new Error(`${historyTable}: the database has migrations this version does not know (${unknown.join(', ')}); upgrade the server`);
            }
            for (const migration of sorted) {
                if (done.has(migration.id)) continue;
                await client.query('BEGIN');
                try {
                    await client.query(migration.up);
                    await client.query(`INSERT INTO ${historyTable} (id, name) VALUES ($1, $2)`, [migration.id, migration.name]);
                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw new Error(`${historyTable}: migration ${migration.id} (${migration.name}) failed: ${(err as Error).message}`);
                }
                applied.push(migration.id);
            }
        } finally {
            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [historyTable]);
        }
    } finally {
        client.release();
    }
    return applied;
}
