/** Logger interface for recording messages during job execution. */
export interface ICliJobLogger {
    /** Logs a debug-level message. */
    debug(message: string): void;
    /** Logs an informational message. */
    info(message: string): void;
    /** Logs a warning message. */
    warning(message: string): void;
    /** Logs an error message. */
    error(message: string): void;
}
