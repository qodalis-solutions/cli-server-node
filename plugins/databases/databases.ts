import type { ICliAuditStore, ICliEventBus } from '@qodalis/cli-server-abstractions';
import { CliMigrationError, CliMigrationRunner, type CliMigrationRun, type CliMigrationRunOptions } from './runner';
import { collectDatabaseStats, databaseSize, type CliDatabaseStats } from './stats';

/** A database in the list (`GET /api/v1/qcli/databases`). */
export interface CliDatabaseSummary {
    name: string;
    dialect: string;
    sources: string[];
    applied: number;
    pending: number;
    /** Migrations `changed`, `missing` or `failed`. */
    problems: number;
    lastRun?: Pick<CliMigrationRun, 'id' | 'direction' | 'status' | 'startedAt' | 'finishedAt' | 'actor' | 'trigger' | 'error'>;
    /** Its size in bytes, when the database tells. */
    sizeBytes?: number;
    /** Set when the database could not be read (down, wrong credentials). */
    error?: string;
}

/** The event published after every migration run (audience `databases:read`). */
export const MIGRATION_RUN_EVENT = 'databases:migration-run';

/** The registered databases: their stats, migrations and what happens around a run (event, audit entry). */
export class CliDatabases {
    private readonly runners = new Map<string, CliMigrationRunner>();
    private eventBus?: ICliEventBus;
    private auditStore?: ICliAuditStore;

    add(runner: CliMigrationRunner): void {
        if (this.runners.has(runner.name)) throw new Error(`migration database already added: ${runner.name}`);
        this.runners.set(runner.name, runner);
    }

    database(name: string): CliMigrationRunner | undefined {
        return this.runners.get(name);
    }

    get databases(): CliMigrationRunner[] {
        return [...this.runners.values()];
    }

    setEventBus(eventBus: ICliEventBus | undefined): void {
        this.eventBus = eventBus;
    }

    setAuditStore(store: ICliAuditStore | undefined): void {
        this.auditStore = store;
    }

    async overview(): Promise<CliDatabaseSummary[]> {
        return Promise.all(this.databases.map((db) => this.summary(db)));
    }

    /** A database's stats: size, connections, load counters, largest tables. */
    stats(name: string): Promise<CliDatabaseStats> {
        const db = this.database(name);
        if (!db) throw new CliMigrationError(`unknown database: ${name}`, 404);
        return collectDatabaseStats(db.name, db.connection);
    }

    /** One database of the list: migration counts, last run and size. */
    async summary(db: CliMigrationRunner): Promise<CliDatabaseSummary> {
        const base = {
            name: db.name,
            dialect: db.dialect,
            sources: db.sourceNames,
        };
        try {
            const [states, runs, sizeBytes] = await Promise.all([db.status(), db.runs(1, 0), databaseSize(db.connection)]);
            const last = runs.items[0];
            return {
                ...base,
                ...(sizeBytes !== undefined ? { sizeBytes } : {}),
                applied: states.filter((s) => s.status === 'applied').length,
                pending: states.filter((s) => s.status === 'pending' || s.status === 'failed').length,
                problems: states.filter((s) => s.status === 'changed' || s.status === 'missing' || s.status === 'failed').length,
                ...(last
                    ? {
                          lastRun: {
                              id: last.id,
                              direction: last.direction,
                              status: last.status,
                              startedAt: last.startedAt,
                              trigger: last.trigger,
                              ...(last.finishedAt ? { finishedAt: last.finishedAt } : {}),
                              ...(last.actor ? { actor: last.actor } : {}),
                              ...(last.error ? { error: last.error } : {}),
                          },
                      }
                    : {}),
            };
        } catch (err) {
            return {
                ...base,
                applied: 0,
                pending: 0,
                problems: 0,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /** Runs up or down on a database, then publishes the event and writes the audit entry. */
    async run(name: string, direction: 'up' | 'down', options: CliMigrationRunOptions): Promise<CliMigrationRun> {
        const db = this.database(name);
        if (!db) throw new CliMigrationError(`unknown database: ${name}`, 404);
        const run = (direction === 'up' ? await db.up(options) : await db.down({ ...options, to: options.to! })) as CliMigrationRun;
        const summary = run.applied.map((a) => `${a.source}:${a.id}`).join(', ') || 'nothing to do';
        await this.eventBus?.publish(
            MIGRATION_RUN_EVENT,
            {
                database: name,
                run: run.id,
                direction,
                status: run.status,
                count: run.applied.length,
                ...(run.error ? { error: run.error } : {}),
            },
            { permission: 'databases:read' },
        );
        await this.auditStore
            ?.log({
                timestamp: Date.now(),
                event: `migrations.${direction}`,
                username: run.actor ?? run.trigger,
                ...(run.actor ? { actor: run.actor } : {}),
                target: `database:${name}`,
                details: run.status === 'failed' ? `${summary}; failed: ${run.error}` : summary,
                properties: {
                    run: run.id,
                    status: run.status,
                    trigger: run.trigger,
                    applied: run.applied.length,
                },
            })
            .catch(() => undefined);
        return run;
    }
}
