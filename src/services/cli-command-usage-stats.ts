/** Usage of one root command since the server started. */
export interface CliCommandUsage {
    /** Root command name, lower-case. */
    command: string;
    /** Whether a registered processor handles it. */
    known: boolean;
    executions: number;
    /** Executions that ended with a non-zero exit code or an exception. */
    failures: number;
    /** Average duration in milliseconds. */
    avgDuration: number;
    /** ISO 8601 UTC time of the latest execution. */
    lastExecutedAt: string | null;
    /** ISO 8601 UTC time of the latest failure. */
    lastFailedAt: string | null;
}

/** `GET /api/v1/qcli/commands/stats` */
export interface CliCommandUsageStatsResponse {
    /** When counting started (server start), ISO 8601 UTC. */
    since: string;
    /** Sorted by executions descending, then name. */
    commands: CliCommandUsage[];
}

interface Counter {
    known: boolean;
    executions: number;
    failures: number;
    totalDuration: number;
    lastExecutedAt?: number;
    lastFailedAt?: number;
}

/**
 * Counts command executions in memory since start: executions, failures, total
 * duration and the latest times, keyed by the root command name (lower-case).
 * Node runs request handlers on one thread, so updates need no locking.
 */
export class CliCommandUsageStats {
    private readonly _counters = new Map<string, Counter>();
    readonly since: Date;

    constructor(since: Date = new Date()) {
        this.since = since;
    }

    /** The key of a command line: its first word, lower-case. */
    static keyOf(command: unknown): string {
        if (typeof command !== 'string') return '';
        return command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    }

    /** Records one execution. */
    record(command: unknown, known: boolean, durationMs: number, failed: boolean, at: Date = new Date()): void {
        const key = CliCommandUsageStats.keyOf(command);
        if (!key) return;
        let counter = this._counters.get(key);
        if (!counter) {
            counter = { known, executions: 0, failures: 0, totalDuration: 0 };
            this._counters.set(key, counter);
        }
        counter.known = known;
        counter.executions++;
        counter.totalDuration += Math.max(0, durationMs);
        counter.lastExecutedAt = at.getTime();
        if (failed) {
            counter.failures++;
            counter.lastFailedAt = at.getTime();
        }
    }

    /** The counters, sorted by executions descending, then name. */
    snapshot(): CliCommandUsageStatsResponse {
        const commands: CliCommandUsage[] = Array.from(this._counters.entries()).map(([command, c]) => ({
            command,
            known: c.known,
            executions: c.executions,
            failures: c.failures,
            avgDuration: c.executions === 0 ? 0 : Math.round((c.totalDuration / c.executions) * 10) / 10,
            lastExecutedAt: c.lastExecutedAt === undefined ? null : new Date(c.lastExecutedAt).toISOString(),
            lastFailedAt: c.lastFailedAt === undefined ? null : new Date(c.lastFailedAt).toISOString(),
        }));
        commands.sort((a, b) => b.executions - a.executions || (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
        return { since: this.since.toISOString(), commands };
    }
}
