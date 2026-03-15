export type JobLogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface JobLogEntry {
    timestamp: string;
    level: JobLogLevel;
    message: string;
}
