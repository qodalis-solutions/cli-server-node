import { JobExecution, JobExecutionStatus } from './job-execution';
import { JobExecutionQuery, mergeJobExecutions } from './job-execution-query';
import { JobExecutionSummary, summarizeJobRuns } from './job-execution-summary';
import { JobState } from './job-state';
import { JobHistoryRetention } from './job-history-retention';

/** Persistence provider for job execution records and job state. */
export interface ICliJobStorageProvider {
    /** Persists or updates a job execution record. */
    saveExecution(execution: JobExecution): Promise<void>;
    /**
     * Retrieves paginated execution records for a job. A store may leave the logs out (setting
     * `logCount`); {@link getExecution} returns a run with its logs.
     * @param jobId - Job identifier.
     * @param options - Pagination and filter options.
     * @returns Paginated result with items and total count.
     */
    getExecutions(
        jobId: string,
        options?: { limit?: number; offset?: number; status?: JobExecutionStatus },
    ): Promise<{ items: JobExecution[]; total: number }>;
    /**
     * Retrieves the executions of several jobs (or of every job), newest first.
     * Optional: without it {@link queryJobExecutions} merges {@link getExecutions}
     * per job, which needs `query.jobIds`. Implement it to query the store once.
     */
    queryExecutions?(query: JobExecutionQuery): Promise<{ items: JobExecution[]; total: number }>;
    /**
     * Per job and status, how many runs started at or after `since` and when the newest one
     * started ("last success per job", "runs in the last 24 hours") without loading the runs.
     * Only the jobs of `jobIds`, or every job. Optional: without it {@link summarizeJobExecutions}
     * pages through {@link queryJobExecutions} and groups in memory; database stores implement
     * it with a `GROUP BY`.
     */
    summarizeExecutions?(since: Date, jobIds?: string[]): Promise<JobExecutionSummary[]>;
    /**
     * Deletes the executions (and their logs) that started before `before`; returns
     * how many. Run it on a schedule to keep the history bounded. Optional: without
     * it nothing is deleted ({@link pruneJobExecutions} returns 0).
     */
    prune?(before: Date): Promise<number>;
    /**
     * Deletes the executions (and their logs) that break the history retention: per job, the
     * runs older than its age limit or beyond its count limit (failed runs under the failed
     * limits when set). Never a running execution or the newest execution of a job. Returns how
     * many. Optional: without it the jobs plugin falls back to an age-only {@link prune}.
     * Database providers should delete set-based (e.g. runs not among the newest N).
     */
    pruneHistory?(retention: JobHistoryRetention): Promise<number>;
    /**
     * Deletes an execution (a run the job discarded, see `context.discard()`);
     * returns whether it was deleted. Optional: without it every execution is kept.
     */
    deleteExecution?(executionId: string): Promise<boolean>;
    /** Retrieves a single execution record by ID, with its logs, or null if not found. */
    getExecution(executionId: string): Promise<JobExecution | null>;
    /** Persists the current state (active/paused/stopped) for a job. */
    saveJobState(jobId: string, state: JobState): Promise<void>;
    /** Retrieves the persisted state for a job, or null if none exists. */
    getJobState(jobId: string): Promise<JobState | null>;
    /** Retrieves all persisted job states keyed by job ID. */
    getAllJobStates(): Promise<Map<string, JobState>>;
}

/**
 * The executions of several jobs, newest first: the storage's own
 * `queryExecutions`, else its per-job listings merged (which needs `query.jobIds`;
 * listing every job throws).
 */
export async function queryJobExecutions(
    storage: ICliJobStorageProvider,
    query: JobExecutionQuery,
): Promise<{ items: JobExecution[]; total: number }> {
    if (storage.queryExecutions) return storage.queryExecutions(query);
    if (!query.jobIds) {
        throw new Error('Listing the executions of every job is not supported by this store');
    }
    return mergeJobExecutions(query, query.jobIds, (jobId, limit, status) =>
        storage.getExecutions(jobId, { limit, offset: 0, status }),
    );
}

/**
 * Per job and status, the number of runs started at or after `since` and the start of the
 * newest one: the storage's own `summarizeExecutions`, else its runs read a page at a time
 * (without logs) and grouped in memory (which, like {@link queryJobExecutions}, needs
 * `jobIds` when the storage has no query of its own).
 */
export async function summarizeJobExecutions(
    storage: ICliJobStorageProvider,
    since: Date,
    jobIds?: string[],
): Promise<JobExecutionSummary[]> {
    if (storage.summarizeExecutions) return storage.summarizeExecutions(since, jobIds);
    const pageSize = 500;
    const runs: JobExecution[] = [];
    for (let offset = 0; ; offset += pageSize) {
        const page = await queryJobExecutions(storage, { jobIds, since, limit: pageSize, offset });
        runs.push(...page.items);
        if (page.items.length < pageSize || offset + page.items.length >= page.total) break;
    }
    return summarizeJobRuns(runs);
}

/** Deletes the executions started before `before` (`storage.prune`); 0 when the storage keeps everything. */
export async function pruneJobExecutions(storage: ICliJobStorageProvider, before: Date): Promise<number> {
    return storage.prune ? storage.prune(before) : 0;
}

/** Deletes one execution (`storage.deleteExecution`); false when the storage keeps every execution. */
export async function deleteJobExecution(storage: ICliJobStorageProvider, executionId: string): Promise<boolean> {
    return storage.deleteExecution ? storage.deleteExecution(executionId) : false;
}
