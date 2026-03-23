/** Lifecycle status of a registered job. */
export type JobStatus = 'active' | 'paused' | 'stopped';

/** Persisted state snapshot for a registered job. */
export interface JobState {
    /** Current lifecycle status. */
    status: JobStatus;
    /** ISO 8601 timestamp of the last execution, if any. */
    lastRunAt?: string;
    /** ISO 8601 timestamp when the state was last modified. */
    updatedAt: string;
}
