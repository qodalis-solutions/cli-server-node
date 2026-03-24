/** Severity levels for job log entries. */
export type JobLogLevel = 'debug' | 'info' | 'warning' | 'error';

/** A single log entry recorded during job execution. */
export interface JobLogEntry {
    /** ISO 8601 timestamp when the entry was created. */
    timestamp: string;
    /** Severity level. */
    level: JobLogLevel;
    /** Log message content. */
    message: string;
}
