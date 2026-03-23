import { JobExecution, JobExecutionStatus } from './job-execution';
import { JobState } from './job-state';

/** Persistence provider for job execution records and job state. */
export interface ICliJobStorageProvider {
    /** Persists or updates a job execution record. */
    saveExecution(execution: JobExecution): Promise<void>;
    /**
     * Retrieves paginated execution records for a job.
     * @param jobId - Job identifier.
     * @param options - Pagination and filter options.
     * @returns Paginated result with items and total count.
     */
    getExecutions(
        jobId: string,
        options?: { limit?: number; offset?: number; status?: JobExecutionStatus },
    ): Promise<{ items: JobExecution[]; total: number }>;
    /** Retrieves a single execution record by ID, or null if not found. */
    getExecution(executionId: string): Promise<JobExecution | null>;
    /** Persists the current state (active/paused/stopped) for a job. */
    saveJobState(jobId: string, state: JobState): Promise<void>;
    /** Retrieves the persisted state for a job, or null if none exists. */
    getJobState(jobId: string): Promise<JobState | null>;
    /** Retrieves all persisted job states keyed by job ID. */
    getAllJobStates(): Promise<Map<string, JobState>>;
}
