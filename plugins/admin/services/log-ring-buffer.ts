/**
 * Circular buffer capturing application logs for the admin dashboard.
 */

/** A single log entry captured by the ring buffer. */
export interface LogEntry {
    timestamp: string;
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
    message: string;
    source: string;
}

/** Filtering and pagination parameters for querying the log buffer. */
export interface LogQueryParams {
    /** One level or several, comma-separated (`WARN,ERROR`), case-insensitive. */
    level?: string;
    /** Literal text, case-insensitive, in the message or the source. */
    search?: string;
    /** The source (service) that wrote the entry, case-insensitive. */
    service?: string;
    limit?: number;
    offset?: number;
}

/** The levels a histogram counts. */
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

/** Counts per level. */
export type LogLevelCounts = Record<(typeof LOG_LEVELS)[number], number>;

/** Parameters of {@link LogRingBuffer.histogram}: the filters of a query and the range. */
export interface LogHistogramParams extends Pick<LogQueryParams, 'level' | 'search' | 'service'> {
    /** Start of the range (inclusive). */
    from: Date;
    /** End of the range (exclusive). */
    to: Date;
    /** Number of columns (already clamped). */
    buckets: number;
}

/** `GET /api/v1/qcli/logs/histogram` */
export interface LogHistogramResult {
    from: string;
    to: string;
    bucketMs: number;
    buckets: ({ start: string } & LogLevelCounts)[];
    totals: LogLevelCounts;
    store: 'memory';
}

/** Result of a log buffer query, including matched entries and total count. */
export interface LogQueryResult {
    entries: LogEntry[];
    total: number;
}

/**
 * Matches a secret written after a `password`/`secret`/`token` label
 * (`password: x`, `token=x`, `password for user "root": x`).
 */
const SECRET_PATTERN = /\b((?:password|passwd|secret|token)\b(?:\s+for\s+user\s+"[^"]*")?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/** Replaces values that look like secrets (see {@link SECRET_PATTERN}) with `[REDACTED]`. */
export function redactSecrets(message: string): string {
    return message.replace(SECRET_PATTERN, '$1[REDACTED]');
}

/** The test an entry must pass for the level, search and service filters. */
export function logEntryFilter(params: Pick<LogQueryParams, 'level' | 'search' | 'service'>): (entry: LogEntry) => boolean {
    const levels = params.level
        ? new Set(params.level.split(',').map((l) => l.trim().toUpperCase()).filter(Boolean))
        : undefined;
    const search = params.search ? params.search.toLowerCase() : undefined;
    const service = params.service ? params.service.trim().toLowerCase() : undefined;
    return (entry) => {
        if (levels && levels.size > 0 && !levels.has(entry.level)) return false;
        if (search && !entry.message.toLowerCase().includes(search) && !(entry.source ?? '').toLowerCase().includes(search)) {
            return false;
        }
        if (service && (entry.source ?? '').toLowerCase() !== service) return false;
        return true;
    };
}

export class LogRingBuffer {
    private readonly _buffer: LogEntry[];
    private readonly _capacity: number;
    private _head = 0;
    private _count = 0;
    private _broadcastFn?: (message: Record<string, unknown>) => void;

    private _origLog?: typeof console.log;
    private _origWarn?: typeof console.warn;
    private _origError?: typeof console.error;

    constructor(capacity = 1000) {
        this._capacity = capacity;
        this._buffer = new Array(capacity);
    }

    /** Set the function used to broadcast new log entries (e.g. via WebSocket). */
    setBroadcastFn(fn: (message: Record<string, unknown>) => void): void {
        this._broadcastFn = fn;
    }

    /**
     * Add a log entry to the buffer.
     */
    push(entry: LogEntry): void {
        // Safety net: entries are served to the dashboard and broadcast to sockets
        entry.message = redactSecrets(entry.message);
        entry.level = entry.level.toUpperCase() as LogEntry['level'];
        this._buffer[this._head] = entry;
        this._head = (this._head + 1) % this._capacity;
        if (this._count < this._capacity) {
            this._count++;
        }

        if (this._broadcastFn) {
            this._broadcastFn({
                type: 'log:entry',
                ...entry,
            });
        }
    }

    /**
     * Query the buffer with optional filtering and pagination.
     */
    query(params: LogQueryParams = {}): LogQueryResult {
        const { limit = 100, offset = 0 } = params;

        const entries = this.getAll().filter(logEntryFilter(params));

        const total = entries.length;
        const paged = entries.slice(offset, offset + limit);

        return { entries: paged, total };
    }

    /**
     * Counts the entries matching the filters per level in each column of
     * `[from, to)`: column i covers `[from + i*bucketMs, from + (i+1)*bucketMs)`.
     */
    histogram(params: LogHistogramParams): LogHistogramResult {
        const from = params.from.getTime();
        const to = params.to.getTime();
        const bucketMs = Math.max(1, Math.floor((to - from) / params.buckets));
        const empty = (): LogLevelCounts => ({ DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 });
        const buckets = Array.from({ length: params.buckets }, (_, i) => ({
            start: new Date(from + i * bucketMs).toISOString(),
            ...empty(),
        }));
        const totals = empty();
        const matches = logEntryFilter(params);
        for (const entry of this.getAll()) {
            const time = new Date(entry.timestamp).getTime();
            if (!(time >= from && time < to) || !matches(entry)) continue;
            const level = entry.level as keyof LogLevelCounts;
            if (!(level in totals)) continue;
            const index = Math.min(params.buckets - 1, Math.floor((time - from) / bucketMs));
            buckets[index][level]++;
            totals[level]++;
        }
        return { from: params.from.toISOString(), to: params.to.toISOString(), bucketMs, buckets, totals, store: 'memory' };
    }

    /**
     * Return all entries in chronological order.
     */
    private getAll(): LogEntry[] {
        if (this._count < this._capacity) {
            return this._buffer.slice(0, this._count);
        }
        // Buffer has wrapped — read from head to end, then start to head
        return [
            ...this._buffer.slice(this._head),
            ...this._buffer.slice(0, this._head),
        ];
    }

    /**
     * Intercept console.log, console.warn, and console.error to capture logs.
     */
    interceptConsole(): void {
        this._origLog = console.log;
        this._origWarn = console.warn;
        this._origError = console.error;

        console.log = (...args: unknown[]) => {
            this.push({
                timestamp: new Date().toISOString(),
                level: 'INFO',
                message: args.map(String).join(' '),
                source: 'console',
            });
            this._origLog!.apply(console, args);
        };

        console.warn = (...args: unknown[]) => {
            this.push({
                timestamp: new Date().toISOString(),
                level: 'WARN',
                message: args.map(String).join(' '),
                source: 'console',
            });
            this._origWarn!.apply(console, args);
        };

        console.error = (...args: unknown[]) => {
            this.push({
                timestamp: new Date().toISOString(),
                level: 'ERROR',
                message: args.map(String).join(' '),
                source: 'console',
            });
            this._origError!.apply(console, args);
        };
    }

    /**
     * Restore original console methods.
     */
    restoreConsole(): void {
        if (this._origLog) console.log = this._origLog;
        if (this._origWarn) console.warn = this._origWarn;
        if (this._origError) console.error = this._origError;
    }
}
