/** Behavior when a job's timer fires while the previous execution is still running. */
export type JobOverlapPolicy = 'skip' | 'queue' | 'cancel';

/** Retry backoff strategy for failed job executions. */
export type JobRetryStrategy = 'fixed' | 'linear' | 'exponential';

/** Configuration options for a scheduled or on-demand CLI job. */
export interface CliJobOptions {
    /**
     * The job's id in the jobs API, its history and its saved state (pause, last run),
     * e.g. `fetch-rates:bnr`. Keep it stable so a restart finds the job's history and
     * state again. Default: the name, with `-2`, `-3`, ... for further jobs of the same
     * name, in registration order. An explicit id used twice throws.
     */
    id?: string;
    /** Display name for the job. Defaults to class name. */
    name?: string;
    /** Description of what the job does. */
    description?: string;
    /** Optional grouping key (e.g., "maintenance"). */
    group?: string;
    /** Cron expression for scheduling. Mutually exclusive with `interval`. */
    schedule?: string;
    /**
     * Simple interval string: "30s", "5m", "1h", "1d". Mutually exclusive with `schedule`.
     * Across restarts and pauses the rhythm is kept: the next run is the last run plus
     * the interval (right away when that has passed).
     */
    interval?: string;
    /**
     * Runs the job once right after the scheduler starts, whatever its schedule (also
     * for jobs that only run on demand). Not for paused or stopped jobs. Default false.
     */
    runOnStart?: boolean;
    /** Whether the job starts in active state. Default true. */
    enabled?: boolean;
    /** Number of retries on failure. Default 1. */
    maxRetries?: number;
    /** Delay before first retry (e.g., "5s", "1m"). Default "5s". */
    retryDelay?: string;
    /** Retry backoff strategy: 'fixed' (constant delay), 'linear' (delay * attempt), 'exponential' (delay * 2^attempt). Default 'exponential'. */
    retryStrategy?: JobRetryStrategy;
    /** Maximum execution time before cancellation (e.g., "5m"). */
    timeout?: string;
    /** Behavior when timer fires while job is already running. Default 'skip'. */
    overlapPolicy?: JobOverlapPolicy;
}
