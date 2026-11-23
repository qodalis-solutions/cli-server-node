import type { ICliAuditStore, ICliEventBus } from '@qodalis/cli-server-abstractions';
import { CliMigrationError, CliMigrationRunner, type CliMigrationRun, type CliMigrationRunOptions } from './runner';

/** A database in the overview (`GET /api/v1/qcli/migrations`). */
export interface CliMigrationDatabaseSummary {
    name: string;
    dialect: string;
    sources: string[];
    applied: number;
    pending: number;
    /** Migrations `changed`, `missing` or `failed`. */
    problems: number;
    lastRun?: Pick<CliMigrationRun, 'id' | 'direction' | 'status' | 'startedAt' | 'finishedAt' | 'actor' | 'trigger' | 'error'>;
    /** Set when the database could not be read (down, wrong credentials). */
    error?: string;
}

/** The event published after every run (audience `migrations:read`). */
export const MIGRATION_RUN_EVENT = 'migrations:run';

/** The registered databases and what happens around a run (event, audit entry). */
export class CliMigrations {
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

    async overview(): Promise<CliMigrationDatabaseSummary[]> {
        return Promise.all(
            this.databases.map(async (db): Promise<CliMigrationDatabaseSummary> => {
                const base = { name: db.name, dialect: db.dialect, sources: db.sourceNames };
                try {
                    const [states, runs] = await Promise.all([db.status(), db.runs(1, 0)]);
                    const last = runs.items[0];
                    return {
                        ...base,
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
                    return { ...base, applied: 0, pending: 0, problems: 0, error: err instanceof Error ? err.message : String(err) };
                }
            }),
        );
    }

    /** Runs up or down on a database, then publishes the event and writes the audit entry. */
    async run(name: string, direction: 'up' | 'down', options: CliMigrationRunOptions): Promise<CliMigrationRun> {
        const db = this.database(name);
        if (!db) throw new CliMigrationError(`unknown database: ${name}`, 404);
        const run = (direction === 'up' ? await db.up(options) : await db.down({ ...options, to: options.to! })) as CliMigrationRun;
        const summary = run.applied.map((a) => `${a.source}:${a.id}`).join(', ') || 'nothing to do';
        await this.eventBus?.publish(
            MIGRATION_RUN_EVENT,
            { database: name, run: run.id, direction, status: run.status, count: run.applied.length, ...(run.error ? { error: run.error } : {}) },
            { permission: 'migrations:read' },
        );
        await this.auditStore
            ?.log({
                timestamp: Date.now(),
                event: `migrations.${direction}`,
                username: run.actor ?? run.trigger,
                ...(run.actor ? { actor: run.actor } : {}),
                target: `database:${name}`,
                details: run.status === 'failed' ? `${summary}; failed: ${run.error}` : summary,
                properties: { run: run.id, status: run.status, trigger: run.trigger, applied: run.applied.length },
            })
            .catch(() => undefined);
        return run;
    }
}
