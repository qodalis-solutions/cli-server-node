import { JobLogEntry } from './log-entry';

/** Possible terminal and in-progress states of a job execution. */
export type JobExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

/** Record of a single job execution attempt. */
export interface JobExecution {
    /** Unique execution identifier. */
    id: string;
    /** Identifier of the job that was executed. */
    jobId: string;
    /** Display name of the job. */
    jobName: string;
    /** Current execution status. */
    status: JobExecutionStatus;
    /** ISO 8601 timestamp when execution started. */
    startedAt: string;
    /** ISO 8601 timestamp when execution completed (if finished). */
    completedAt?: string;
    /** Execution duration in milliseconds. */
    duration?: number;
    /** Error message if the execution failed. */
    error?: string;
    /**
     * Log entries recorded during execution. A store may leave them out of lists (see
     * `JobExecutionQuery.includeLogs`); `getExecution` returns a run with its logs.
     */
    logs: JobLogEntry[];
    /**
     * How many log entries the execution has when a list left {@link logs} out; undefined
     * when `logs` is complete.
     */
    logCount?: number;
    /** Zero-based retry attempt number. */
    retryAttempt: number;
    /**
     * The host's own values for this execution, e.g. `items` and `changed` counts or the
     * record it worked on: set by the job (`context.properties`), saved with the execution
     * and returned by the jobs API. Values must serialize to JSON.
     */
    properties?: Record<string, unknown>;
}
