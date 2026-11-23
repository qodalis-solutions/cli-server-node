import { randomUUID } from 'crypto';
import { qcliTableName, type CliTableNameOptions } from '@qodalis/cli-server-abstractions';
import type { CliSqlConnection, CliSqlSession } from './connection';
import { TRANSACTION, acquireLock, ensureHistoryTables, quoteIdent, quoteTable, releaseLock, tableExists, type HistoryTables } from './dialects';
import { checksumOf, compareIds, stepSql, type CliMigration, type CliMigrationSource } from './sources';

/** Where a migration stands in a database. */
export type CliMigrationStatus = 'applied' | 'pending' | 'changed' | 'missing' | 'failed';

/** A migration with its status (`GET /api/v1/qcli/migrations/{db}`). */
export interface CliMigrationState {
    source: string;
    id: string;
    name: string;
    status: CliMigrationStatus;
    appliedAt?: string;
    durationMs?: number;
    appliedBy?: string;
    hasDown: boolean;
}

/** What started a run. */
export type CliMigrationTrigger = 'startup' | 'api' | 'terminal' | 'mcp';

/** One invocation of up or down, kept in `QcliMigrationRuns`. */
export interface CliMigrationRun {
    id: string;
    direction: 'up' | 'down';
    target?: string;
    trigger: CliMigrationTrigger;
    actor?: string;
    startedAt: string;
    finishedAt?: string;
    status: 'running' | 'succeeded' | 'failed';
    error?: string;
    /** The migrations it applied (up) or rolled back (down), in order, with their durations. */
    applied: Array<{ source: string; id: string; name: string; durationMs: number }>;
    /** The migration it stopped at. */
    failed?: { source: string; id: string };
}

export interface CliMigrationRunOptions {
    /** Up: stop after this migration (`id` or `source:id`). Down: roll back to it, keeping it (`base` = everything). */
    to?: string;
    /** Run although a migration is `changed` or `missing` (recorded on the run). */
    force?: boolean;
    /** Return the SQL instead of running it. */
    dryRun?: boolean;
    actor?: string;
    trigger?: CliMigrationTrigger;
    /** Wait for another process's run instead of answering busy (startup does). */
    wait?: boolean;
}

/** A refused request: `status` is the HTTP status the API answers. */
export class CliMigrationError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 409,
    ) {
        super(message);
        this.name = 'CliMigrationError';
    }
}

/** A database to migrate. */
export interface CliMigrationDatabaseOptions extends Pick<CliTableNameOptions, 'tablePrefix' | 'schema' | 'tables'> {
    connection: CliSqlConnection;
    /** Apply pending migrations when the server starts (it waits for them; a failure stops startup). */
    applyOnStartup?: boolean;
}

interface Loaded {
    source: string;
    migration: CliMigration;
    checksum: string | null;
}

interface HistoryRow {
    Source: string;
    Id: string;
    Name: string;
    Checksum: string | null;
    AppliedAt: unknown;
    DurationMs: number;
    AppliedBy: string | null;
}

const iso = (value: unknown): string | undefined => {
    if (value === null || value === undefined) return undefined;
    const date = value instanceof Date ? value : new Date(String(value).replace(' ', 'T').replace(/(T[\d:.]+)$/, '$1Z'));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

/** Runs one database's migrations: status, up, down, and the run history. */
export class CliMigrationRunner {
    readonly tables: HistoryTables;
    private readonly sources: CliMigrationSource[] = [];
    private running: Promise<unknown> | null = null;

    constructor(
        readonly name: string,
        readonly options: CliMigrationDatabaseOptions,
    ) {
        this.tables = {
            migrations: qcliTableName('Migrations', options),
            runs: qcliTableName('MigrationRuns', options),
        };
    }

    get dialect() {
        return this.options.connection.dialect;
    }

    /** The database's connection (stats run on it too). */
    get connection(): CliSqlConnection {
        return this.options.connection;
    }

    /** Adds a source; sources apply in the order they were added. */
    addSource(source: CliMigrationSource): this {
        if (this.sources.some((s) => s.name === source.name)) throw new Error(`migration source already added to ${this.name}: ${source.name}`);
        this.sources.push(source);
        return this;
    }

    get sourceNames(): string[] {
        return this.sources.map((s) => s.name);
    }

    /** Every migration of every source, in order, with its checksum. */
    private async load(): Promise<Loaded[]> {
        const out: Loaded[] = [];
        for (const source of this.sources) {
            const migrations = (await source.load()).sort((a, b) => compareIds(a.id, b.id));
            for (let i = 1; i < migrations.length; i++) {
                if (migrations[i].id === migrations[i - 1].id) throw new Error(`duplicate migration ${source.name}:${migrations[i].id}`);
            }
            for (const migration of migrations) out.push({ source: source.name, migration, checksum: checksumOf(migration, this.dialect) });
        }
        return out;
    }

    private table(name: string): string {
        return quoteTable(this.dialect, name, this.options.schema);
    }

    private col(name: string): string {
        return quoteIdent(this.dialect, name);
    }

    private async history(db: CliSqlSession): Promise<HistoryRow[]> {
        if (!(await tableExists(db, this.tables.migrations, this.options.schema))) return [];
        const c = (n: string) => this.col(n);
        return db.query<HistoryRow>(
            `SELECT ${['Source', 'Id', 'Name', 'Checksum', 'AppliedAt', 'DurationMs', 'AppliedBy'].map(c).join(', ')} FROM ${this.table(this.tables.migrations)}`,
        );
    }

    private async lastFailure(db: CliSqlSession): Promise<{ source: string; id: string } | undefined> {
        const run = (await this.runsOn(db, 1, 0)).items[0];
        return run?.status === 'failed' ? run.failed : undefined;
    }

    private statesOf(loaded: Loaded[], rows: HistoryRow[], failed?: { source: string; id: string }): CliMigrationState[] {
        const key = (source: string, id: string) => `${source}\u0000${id}`;
        const applied = new Map(rows.map((r) => [key(r.Source, String(r.Id)), r]));
        const known = new Set(loaded.map((l) => key(l.source, l.migration.id)));
        const states: CliMigrationState[] = loaded.map(({ source, migration, checksum }) => {
            const row = applied.get(key(source, migration.id));
            const base = { source, id: migration.id, name: migration.name, hasDown: migration.down !== undefined };
            if (!row) {
                const isFailed = failed?.source === source && failed.id === migration.id;
                return { ...base, status: isFailed ? 'failed' : 'pending' };
            }
            return {
                ...base,
                status: row.Checksum && checksum && row.Checksum !== checksum ? 'changed' : 'applied',
                appliedAt: iso(row.AppliedAt),
                durationMs: Number(row.DurationMs),
                ...(row.AppliedBy ? { appliedBy: row.AppliedBy } : {}),
            };
        });
        // Applied, but gone from its source (a source this runner still has)
        const sources = new Set(this.sourceNames);
        for (const row of rows) {
            if (sources.has(row.Source) && !known.has(key(row.Source, String(row.Id)))) {
                states.push({
                    source: row.Source,
                    id: String(row.Id),
                    name: row.Name,
                    status: 'missing',
                    appliedAt: iso(row.AppliedAt),
                    durationMs: Number(row.DurationMs),
                    hasDown: false,
                    ...(row.AppliedBy ? { appliedBy: row.AppliedBy } : {}),
                });
            }
        }
        return states;
    }

    /** Every migration with its status. */
    async status(): Promise<CliMigrationState[]> {
        const loaded = await this.load();
        return this.options.connection.session(async (db) => this.statesOf(loaded, await this.history(db), await this.lastFailure(db)));
    }

    /**
     * The statuses and the last run in one session, with `more` run in the same session (the databases list adds the
     * size): one connection per database instead of one per query.
     */
    async overview<T>(more: (db: CliSqlSession) => Promise<T>): Promise<{ states: CliMigrationState[]; lastRun?: CliMigrationRun; more: T }> {
        const loaded = await this.load();
        return this.options.connection.session(async (db) => {
            const states = this.statesOf(loaded, await this.history(db), await this.lastFailure(db));
            const lastRun = (await this.runsOn(db, 1, 0)).items[0];
            return { states, ...(lastRun ? { lastRun } : {}), more: await more(db) };
        });
    }

    /** The latest runs, newest first. */
    async runs(limit = 20, offset = 0): Promise<{ items: CliMigrationRun[]; total: number }> {
        return this.options.connection.session((db) => this.runsOn(db, limit, offset));
    }

    private async runsOn(db: CliSqlSession, limit: number, offset: number): Promise<{ items: CliMigrationRun[]; total: number }> {
        if (!(await tableExists(db, this.tables.runs, this.options.schema))) return { items: [], total: 0 };
        const c = (n: string) => this.col(n);
        const table = this.table(this.tables.runs);
        const total = Number((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ?? 0);
        const page =
            this.dialect === 'mssql'
                ? `OFFSET ${Math.max(0, Math.floor(offset))} ROWS FETCH NEXT ${Math.max(1, Math.floor(limit))} ROWS ONLY`
                : `LIMIT ${Math.max(1, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`;
        const rows = await db.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${c('StartedAt')} DESC, ${c('Id')} DESC ${page}`);
        return { items: rows.map((r) => this.runOf(r)), total };
    }

    private runOf(r: Record<string, unknown>): CliMigrationRun {
        const detail = r.Applied ? (JSON.parse(String(r.Applied)) as Pick<CliMigrationRun, 'applied' | 'failed'>) : { applied: [] };
        return {
            id: String(r.Id),
            direction: r.Direction as 'up' | 'down',
            ...(r.Target ? { target: String(r.Target) } : {}),
            trigger: r.Trigger as CliMigrationTrigger,
            ...(r.Actor ? { actor: String(r.Actor) } : {}),
            startedAt: iso(r.StartedAt)!,
            ...(r.FinishedAt ? { finishedAt: iso(r.FinishedAt) } : {}),
            status: r.Status as CliMigrationRun['status'],
            ...(r.Error ? { error: String(r.Error) } : {}),
            applied: detail.applied ?? [],
            ...(detail.failed ? { failed: detail.failed } : {}),
        };
    }

    /** Finds a migration by `id` or `source:id`. */
    private find(loaded: Loaded[], target: string): number {
        const colon = target.indexOf(':');
        const matches = loaded
            .map((l, i) => ({ l, i }))
            .filter(({ l }) => (colon > 0 ? `${l.source}:${l.migration.id}` === target : l.migration.id === target));
        if (matches.length === 0) throw new CliMigrationError(`unknown migration: ${target}`, 404);
        if (matches.length > 1) throw new CliMigrationError(`migration ${target} is in several sources: name it as source:id`, 400);
        return matches[0].i;
    }

    /** Applies pending migrations (up to `to`). Dry run: the SQL it would run. */
    up(options: CliMigrationRunOptions = {}): Promise<CliMigrationRun | { sql: string }> {
        return this.exclusive(options, (db, loaded) => this.runUp(db, loaded, options));
    }

    /** Rolls back applied migrations, newest first, down to `to` (kept; `base` = everything). */
    down(options: CliMigrationRunOptions & { to: string }): Promise<CliMigrationRun | { sql: string }> {
        return this.exclusive(options, (db, loaded) => this.runDown(db, loaded, options));
    }

    /** Runs `fn` alone: one run per process at a time, and the database lock across processes. */
    private async exclusive<T>(options: CliMigrationRunOptions, fn: (db: CliSqlSession, loaded: Loaded[]) => Promise<T>): Promise<T> {
        if (options.dryRun) {
            const loaded = await this.load();
            return this.options.connection.session((db) => fn(db, loaded));
        }
        while (this.running) {
            if (!options.wait) throw new CliMigrationError(`a migration run is in progress on ${this.name}`, 409);
            await this.running.catch(() => undefined);
        }
        const run = (async () => {
            const loaded = await this.load();
            return this.options.connection.session(async (db) => {
                const key = `qcli-migrations:${this.options.schema ?? ''}.${this.tables.migrations}`;
                if (!(await acquireLock(db, key, options.wait ?? false))) {
                    throw new CliMigrationError(`a migration run is in progress on ${this.name}`, 409);
                }
                try {
                    await ensureHistoryTables(db, this.tables, this.options.schema);
                    return await fn(db, loaded);
                } finally {
                    await releaseLock(db, key).catch(() => undefined);
                }
            });
        })();
        this.running = run;
        try {
            return await run;
        } finally {
            this.running = null;
        }
    }

    private blocked(states: CliMigrationState[], force: boolean | undefined): void {
        const problems = states.filter((s) => s.status === 'changed' || s.status === 'missing');
        if (problems.length > 0 && !force) {
            throw new CliMigrationError(
                `migrations changed or missing since they were applied: ${problems.map((p) => `${p.source}:${p.id} (${p.status})`).join(', ')}; fix them or run with force`,
                409,
            );
        }
    }

    private async runUp(db: CliSqlSession, loaded: Loaded[], options: CliMigrationRunOptions): Promise<CliMigrationRun | { sql: string }> {
        const rows = await this.history(db);
        const states = this.statesOf(loaded, rows);
        this.blocked(states, options.force);
        const last = options.to !== undefined ? this.find(loaded, options.to) : loaded.length - 1;
        const pending = loaded.filter((l, i) => i <= last && states[i].status !== 'applied' && states[i].status !== 'changed');
        if (options.dryRun) return { sql: this.script(pending, 'up') };
        return this.record(db, 'up', options, pending, async (l) => {
            const started = Date.now();
            await this.apply(db, l, 'up', async (durationMs) => {
                const c = (n: string) => this.col(n);
                await db.query(
                    `INSERT INTO ${this.table(this.tables.migrations)} (${['Source', 'Id', 'Name', 'Checksum', 'AppliedAt', 'DurationMs', 'AppliedBy', 'RunId']
                        .map(c)
                        .join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [l.source, l.migration.id, l.migration.name, l.checksum, new Date(), durationMs, options.actor ?? null, this.currentRun],
                );
            });
            return Date.now() - started;
        });
    }

    private async runDown(db: CliSqlSession, loaded: Loaded[], options: CliMigrationRunOptions & { to: string }): Promise<CliMigrationRun | { sql: string }> {
        const rows = await this.history(db);
        const states = this.statesOf(loaded, rows);
        const keep = options.to === 'base' ? -1 : this.find(loaded, options.to);
        const undo = loaded.filter((_, i) => i > keep && (states[i].status === 'applied' || states[i].status === 'changed')).reverse();
        const noDown = undo.filter((l) => l.migration.down === undefined);
        if (noDown.length > 0) {
            throw new CliMigrationError(`cannot roll back: no down step for ${noDown.map((l) => `${l.source}:${l.migration.id}`).join(', ')}`, 409);
        }
        if (options.dryRun) return { sql: this.script(undo, 'down') };
        return this.record(db, 'down', options, undo, async (l) => {
            const started = Date.now();
            await this.apply(db, l, 'down', async () => {
                const c = (n: string) => this.col(n);
                await db.query(`DELETE FROM ${this.table(this.tables.migrations)} WHERE ${c('Source')} = ? AND ${c('Id')} = ?`, [l.source, l.migration.id]);
            });
            return Date.now() - started;
        });
    }

    /** The SQL of the steps, for a dry run (code steps show as a comment). */
    private script(list: Loaded[], direction: 'up' | 'down'): string {
        return list
            .map((l) => {
                const step = direction === 'up' ? l.migration.up : l.migration.down!;
                const sql = stepSql(step, this.dialect, l.migration.id);
                return `-- ${l.source}:${l.migration.id} ${l.migration.name} (${direction})\n${sql ?? '-- (code: runs a function, no SQL to show)'}`;
            })
            .join('\n\n');
    }

    private currentRun: string | null = null;

    /** Runs the step and its history change, in one transaction unless the migration opts out. */
    private async apply(db: CliSqlSession, l: Loaded, direction: 'up' | 'down', bookkeeping: (durationMs: number) => Promise<void>): Promise<void> {
        const step = direction === 'up' ? l.migration.up : l.migration.down!;
        const tx = TRANSACTION[this.dialect];
        const inTransaction = l.migration.transaction !== false;
        const started = Date.now();
        if (inTransaction) await db.exec(tx.begin);
        try {
            const sql = stepSql(step, this.dialect, l.migration.id);
            if (sql === null) await (step as (db: CliSqlSession) => Promise<void>)(db);
            else if (sql.trim()) await db.exec(sql);
            await bookkeeping(Date.now() - started);
            if (inTransaction) await db.exec(tx.commit);
        } catch (err) {
            if (inTransaction) await db.exec(tx.rollback).catch(() => undefined);
            throw err;
        }
    }

    /** Runs the steps, recording the run before, after each step and at the end. */
    private async record(
        db: CliSqlSession,
        direction: 'up' | 'down',
        options: CliMigrationRunOptions,
        list: Loaded[],
        step: (l: Loaded) => Promise<number>,
    ): Promise<CliMigrationRun> {
        const run: CliMigrationRun = {
            id: randomUUID(),
            direction,
            ...(options.to !== undefined ? { target: options.to } : {}),
            trigger: options.trigger ?? 'api',
            ...(options.actor ? { actor: options.actor } : {}),
            startedAt: new Date().toISOString(),
            status: 'running',
            applied: [],
        };
        const c = (n: string) => this.col(n);
        await db.query(
            `INSERT INTO ${this.table(this.tables.runs)} (${['Id', 'Direction', 'Target', 'Trigger', 'Actor', 'StartedAt', 'Status', 'Applied'].map(c).join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [run.id, direction, run.target ?? null, run.trigger, run.actor ?? null, new Date(run.startedAt), 'running', JSON.stringify({ applied: [] })],
        );
        this.currentRun = run.id;
        try {
            for (const l of list) {
                try {
                    const durationMs = await step(l);
                    run.applied.push({ source: l.source, id: l.migration.id, name: l.migration.name, durationMs });
                } catch (err) {
                    run.status = 'failed';
                    run.error = `${l.source}:${l.migration.id} ${l.migration.name}: ${err instanceof Error ? err.message : String(err)}`;
                    run.failed = { source: l.source, id: l.migration.id };
                    break;
                }
            }
        } finally {
            this.currentRun = null;
        }
        if (run.status === 'running') run.status = 'succeeded';
        run.finishedAt = new Date().toISOString();
        await db.query(
            `UPDATE ${this.table(this.tables.runs)} SET ${c('FinishedAt')} = ?, ${c('Status')} = ?, ${c('Error')} = ?, ${c('Applied')} = ? WHERE ${c('Id')} = ?`,
            [new Date(run.finishedAt), run.status, run.error ?? null, JSON.stringify({ applied: run.applied, failed: run.failed }), run.id],
        );
        return run;
    }
}
