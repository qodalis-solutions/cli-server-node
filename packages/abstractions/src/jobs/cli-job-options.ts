export type JobOverlapPolicy = 'skip' | 'queue' | 'cancel';

export interface CliJobOptions {
    /** Display name for the job. Defaults to class name. */
    name?: string;
    /** Description of what the job does. */
    description?: string;
    /** Optional grouping key (e.g., "maintenance"). */
    group?: string;
    /** Cron expression for scheduling. Mutually exclusive with `interval`. */
    schedule?: string;
    /** Simple interval string: "30s", "5m", "1h", "1d". Mutually exclusive with `schedule`. */
    interval?: string;
    /** Whether the job starts in active state. Default true. */
    enabled?: boolean;
    /** Number of retries on failure. Default 0. */
    maxRetries?: number;
    /** Maximum execution time before cancellation (e.g., "5m"). */
    timeout?: string;
    /** Behavior when timer fires while job is already running. Default 'skip'. */
    overlapPolicy?: JobOverlapPolicy;
}
