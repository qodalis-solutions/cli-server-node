/**
 * Circular buffer capturing application logs for the admin dashboard.
 */

export interface LogEntry {
    timestamp: string;
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
    message: string;
    source: string;
}

export interface LogQueryParams {
    level?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

export interface LogQueryResult {
    entries: LogEntry[];
    total: number;
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

    setBroadcastFn(fn: (message: Record<string, unknown>) => void): void {
        this._broadcastFn = fn;
    }

    /**
     * Add a log entry to the buffer.
     */
    push(entry: LogEntry): void {
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
        const { level, search, limit = 100, offset = 0 } = params;

        let entries = this.getAll();

        if (level) {
            const upperLevel = level.toUpperCase();
            entries = entries.filter((e) => e.level === upperLevel);
        }

        if (search) {
            const lower = search.toLowerCase();
            entries = entries.filter((e) => e.message.toLowerCase().includes(lower));
        }

        const total = entries.length;
        const paged = entries.slice(offset, offset + limit);

        return { entries: paged, total };
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
