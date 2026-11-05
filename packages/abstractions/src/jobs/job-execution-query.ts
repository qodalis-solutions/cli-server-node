import { JobExecution, JobExecutionStatus } from './job-execution';

/** Which executions to list across jobs (`GET /api/v1/qcli/jobs/executions`), newest first. */
export interface JobExecutionQuery {
    /** Only the executions of these jobs; undefined for every job. */
    jobIds?: string[];
    /** Only executions with this status (e.g. `failed`), case-insensitive; undefined for any. */
    status?: JobExecutionStatus | string;
    /** Only executions started at or after this time; undefined for any. */
    since?: Date;
    /** Maximum number of executions to return (default 20). */
    limit?: number;
    /** Number of executions to skip (default 0). */
    offset?: number;
}

/** Lists one job's executions, newest first: the first `limit` matching `status`. */
export type JobExecutionListFn = (
    jobId: string,
    limit: number,
    status: JobExecutionStatus | undefined,
) => Promise<{ items: JobExecution[]; total: number }>;

/** Whether an execution matches the query's status and `since` filters (not its job ids). */
export function matchesJobExecutionQuery(execution: JobExecution, query: JobExecutionQuery): boolean {
    if (query.status && execution.status !== query.status.toLowerCase()) return false;
    if (query.since && new Date(execution.startedAt).getTime() < query.since.getTime()) return false;
    return true;
}

/**
 * Lists the executions of several jobs from a per-job listing: reads the first
 * `offset + limit` of each job (all of them with `since`), and merges them newest
 * first. The default for stores and schedulers without a query of their own.
 */
export async function mergeJobExecutions(
    query: JobExecutionQuery,
    jobIds: Iterable<string>,
    listJob: JobExecutionListFn,
): Promise<{ items: JobExecution[]; total: number }> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const status = query.status ? (query.status.toLowerCase() as JobExecutionStatus) : undefined;
    const all: JobExecution[] = [];
    let total = 0;
    for (const jobId of new Set(jobIds)) {
        const result = await listJob(jobId, query.since ? Number.MAX_SAFE_INTEGER : offset + limit, status);
        const matching = query.since ? result.items.filter((e) => matchesJobExecutionQuery(e, query)) : result.items;
        all.push(...matching);
        total += query.since ? matching.length : result.total;
    }
    all.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return { items: all.slice(offset, offset + limit), total };
}
