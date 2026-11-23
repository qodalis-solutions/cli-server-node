import { JobExecution, JobExecutionStatus } from './job-execution';

/**
 * The runs of one job with one status started in a range (`summarizeExecutions`): how many
 * there are and when the newest one started, without loading the runs.
 */
export interface JobExecutionSummary {
    /** The job identifier. */
    jobId: string;
    /** The status of the runs counted. */
    status: JobExecutionStatus;
    /** The number of runs. */
    count: number;
    /** ISO 8601 timestamp when the newest of these runs started. */
    lastStartedAt: string;
}

/**
 * Groups `runs` by job and status, ordered by job id and status: the summary of stores that
 * hold their runs in memory, and the default of {@link summarizeJobExecutions}.
 */
export function summarizeJobRuns(runs: Iterable<JobExecution>): JobExecutionSummary[] {
    const groups = new Map<string, { jobId: string; status: JobExecutionStatus; count: number; last: number }>();
    for (const run of runs) {
        const key = `${run.jobId}\u0000${run.status}`;
        const started = Date.parse(run.startedAt);
        const group = groups.get(key);
        if (group) {
            group.count++;
            if (started > group.last) group.last = started;
        } else {
            groups.set(key, { jobId: run.jobId, status: run.status, count: 1, last: started });
        }
    }
    return Array.from(groups.values())
        .sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : a.status < b.status ? -1 : a.status > b.status ? 1 : 0))
        .map((g) => ({ jobId: g.jobId, status: g.status, count: g.count, lastStartedAt: new Date(g.last).toISOString() }));
}
