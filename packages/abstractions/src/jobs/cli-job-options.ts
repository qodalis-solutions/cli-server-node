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
     * Runs the job when the scheduler starts, unless it ran recently: an interval job when it
     * never ran or its next run is due, a cron job when it never ran or missed an occurrence
     * since its last run, a job without a schedule on every start. Not for paused or stopped
     * jobs. Default false.
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
    /**
     * What happens when a run is due (timer, trigger, run on start) while `maxConcurrentRuns`
     * runs are going: 'skip' drops it (a trigger answers 409), 'queue' queues one run (at most
     * one is pending per job), 'cancel' cancels the oldest run. Default 'skip'.
     */
    overlapPolicy?: JobOverlapPolicy;
    /**
     * Up to this many runs of the job at the same time (integer >= 1). A run holds its slot
     * from its start until it ends, its retries and the delays between them included. Default 1.
     */
    maxConcurrentRuns?: number;
}
