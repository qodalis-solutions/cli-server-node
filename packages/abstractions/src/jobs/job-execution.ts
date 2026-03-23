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
    /** Log entries recorded during execution. */
    logs: JobLogEntry[];
    /** Zero-based retry attempt number. */
    retryAttempt: number;
}
