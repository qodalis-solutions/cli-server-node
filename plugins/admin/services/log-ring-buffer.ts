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
    /** Only entries at or after this time (inclusive). */
    from?: Date;
    /** Only entries before this time (exclusive). */
    to?: Date;
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
    /** Where the entries come from: this buffer, in memory. */
    store: 'memory';
    /** Whether the entries survive a restart (never for the buffer). */
    persistent: false;
    limit: number;
    offset: number;
    /** Whether entries matching the filters follow this page. */
    hasMore: boolean;
    /** The distinct sources in the buffer (what `service` filters by), sorted. */
    services: string[];
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

/** The smallest and largest buffer sizes {@link LogRingBuffer.resize} accepts. */
export const LOG_BUFFER_MIN_CAPACITY = 100;
export const LOG_BUFFER_MAX_CAPACITY = 100_000;

export class LogRingBuffer {
    private _buffer: LogEntry[];
    private _capacity: number;
    private _minLevel: LogEntry['level'] = 'DEBUG';
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

    /** How many entries the buffer keeps. */
    get capacity(): number {
        return this._capacity;
    }

    /** Keeps up to `capacity` entries from now on (the newest ones stay). Changed at runtime by the `logs` config provider. */
    resize(capacity: number): void {
        if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`invalid log buffer capacity: ${capacity}`);
        if (capacity === this._capacity) return;
        const kept = this.getAll().slice(-capacity);
        this._buffer = new Array(capacity);
        kept.forEach((entry, i) => (this._buffer[i] = entry));
        this._capacity = capacity;
        this._count = kept.length;
        this._head = kept.length % capacity;
    }

    /** The lowest level kept (default `DEBUG`: everything); lower entries are neither kept nor broadcast. */
    get minLevel(): LogEntry['level'] {
        return this._minLevel;
    }

    set minLevel(level: LogEntry['level']) {
        const upper = String(level).toUpperCase() as LogEntry['level'];
        if (!(LOG_LEVELS as readonly string[]).includes(upper)) throw new Error(`invalid log level: ${level}`);
        this._minLevel = upper;
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
        const rank = LOG_LEVELS.indexOf(entry.level);
        if (rank >= 0 && rank < LOG_LEVELS.indexOf(this._minLevel)) return;
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
        const limit = Math.max(params.limit ?? 100, 0);
        const offset = Math.max(params.offset ?? 0, 0);
        const all = this.getAll();
        const matches = logEntryFilter(params);
        const from = params.from?.getTime();
        const to = params.to?.getTime();

        const entries = all.filter((e) => {
            if (from !== undefined || to !== undefined) {
                const time = new Date(e.timestamp).getTime();
                if (from !== undefined && !(time >= from)) return false;
                if (to !== undefined && !(time < to)) return false;
            }
            return matches(e);
        });

        const total = entries.length;
        const paged = entries.slice(offset, offset + limit);
        const services = Array.from(new Set(all.map((e) => e.source).filter((s): s is string => !!s))).sort();

        return {
            entries: paged,
            total,
            store: 'memory',
            persistent: false,
            limit,
            offset,
            hasMore: offset + paged.length < total,
            services,
        };
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
