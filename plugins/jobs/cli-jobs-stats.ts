import { JobExecution, JobExecutionQuery } from '@qodalis/cli-server-abstractions';

/** Default and allowed number of columns of a statistics chart. */
export const DEFAULT_STATS_BUCKETS = 24;
export const MAX_STATS_BUCKETS = 200;

/** Runs read per page while collecting the statistics. */
const STATS_PAGE_SIZE = 500;

/** Runs listed per job in `recent`, newest first. */
const RECENT_RUNS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a run's status counts as. */
export type JobRunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'running';

/** Maps a run status to its outcome (`completed` -> succeeded, `timed_out` -> failed, ...). */
export function jobRunOutcome(status: string | undefined): JobRunOutcome {
    switch ((status ?? '').toLowerCase()) {
        case 'completed':
        case 'succeeded':
            return 'succeeded';
        case 'failed':
        case 'error':
        case 'timed_out':
        case 'timedout':
            return 'failed';
        case 'running':
        case 'pending':
            return 'running';
        default:
            return 'cancelled';
    }
}

/**
 * Parses a query time: ISO 8601, read as UTC when it names no offset. Undefined when
 * absent; throws a message for a bad value.
 */
export function parseQueryTime(value: unknown, name: string): Date | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new Error(`${name} must be an ISO 8601 date`);
    const text = value.trim();
    // `2026-11-05T10:00` has no offset: UTC, not the server's local time
    const withZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text}Z` : text;
    const date = /^\d{4}-\d{2}-\d{2}/.test(text) ? new Date(withZone) : new Date(NaN);
    if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO 8601 date`);
    return date;
}

/** A time range cut into equal columns. */
export interface StatsRange {
    since: Date;
    until: Date;
    buckets: number;
    bucketMs: number;
}

/**
 * The range `[since, until)` (default the 24 hours before now) cut into `buckets`
 * columns (1..200, default 24). Throws a message for a bad value.
 */
export function resolveStatsRange(sinceValue: unknown, untilValue: unknown, bucketsValue: unknown, now = new Date()): StatsRange {
    const until = parseQueryTime(untilValue, 'until') ?? now;
    const since = parseQueryTime(sinceValue, 'since') ?? new Date(until.getTime() - DAY_MS);
    if (since.getTime() >= until.getTime()) throw new Error('since must be before until');
    const buckets = clampBuckets(bucketsValue);
    const bucketMs = Math.max(1, Math.floor((until.getTime() - since.getTime()) / buckets));
    return { since, until, buckets, bucketMs };
}

/** The number of columns asked for, clamped to 1..200 (24 when absent or not a number). */
export function clampBuckets(value: unknown): number {
    const parsed = typeof value === 'string' ? parseInt(value, 10) : NaN;
    if (Number.isNaN(parsed)) return DEFAULT_STATS_BUCKETS;
    return Math.min(Math.max(parsed, 1), MAX_STATS_BUCKETS);
}

/** The column a time falls in, or -1 outside the range. */
export function bucketIndex(range: StatsRange, time: number): number {
    if (time < range.since.getTime() || time >= range.until.getTime()) return -1;
    return Math.min(range.buckets - 1, Math.floor((time - range.since.getTime()) / range.bucketMs));
}

/** Counts and durations of a set of runs. */
export interface JobRunSummary {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    running: number;
    successRate: number | null;
    avgDuration: number | null;
    p95Duration: number | null;
    maxDuration: number | null;
    lastFailureAt: string | null;
}

export interface JobStatsBucket {
    start: string;
    succeeded: number;
    failed: number;
    cancelled: number;
    running: number;
}

export interface JobStatsJob extends JobRunSummary {
    jobId: string;
    jobName: string;
    recent: { status: string; startedAt: string; duration: number | null }[];
}

/** `GET /api/v1/qcli/jobs/stats` */
export interface JobStatsResponse {
    since: string;
    until: string;
    bucketMs: number;
    buckets: JobStatsBucket[];
    totals: JobRunSummary;
    jobs: JobStatsJob[];
}

type QueryFn = (query: JobExecutionQuery) => Promise<{ items: JobExecution[]; total: number }>;

/**
 * Reads every run started in the range, page by page through the execution query
 * (so it works with any storage provider), without a fixed cap.
 */
export async function collectRuns(query: QueryFn, jobIds: string[] | undefined, range: StatsRange): Promise<JobExecution[]> {
    const runs: JobExecution[] = [];
    const seen = new Set<string>();
    for (let offset = 0; ; ) {
        const page = await query({ jobIds, since: range.since, limit: STATS_PAGE_SIZE, offset });
        if (page.items.length === 0) break;
        for (const run of page.items) {
            if (seen.has(run.id)) continue;
            seen.add(run.id);
            if (bucketIndex(range, new Date(run.startedAt).getTime()) >= 0) runs.push(run);
        }
        offset += page.items.length;
        if (offset >= page.total) break;
    }
    return runs;
}

/** Builds the statistics of the runs (already limited to the range). */
export function buildJobStats(runs: JobExecution[], range: StatsRange): JobStatsResponse {
    const buckets: JobStatsBucket[] = Array.from({ length: range.buckets }, (_, i) => ({
        start: new Date(range.since.getTime() + i * range.bucketMs).toISOString(),
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        running: 0,
    }));
    const byJob = new Map<string, JobExecution[]>();
    for (const run of runs) {
        const index = bucketIndex(range, new Date(run.startedAt).getTime());
        if (index < 0) continue;
        buckets[index][jobRunOutcome(run.status)]++;
        const list = byJob.get(run.jobId) ?? [];
        list.push(run);
        byJob.set(run.jobId, list);
    }

    const jobs: JobStatsJob[] = Array.from(byJob.keys())
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((jobId) => {
            const jobRuns = byJob.get(jobId)!.slice().sort(newestFirst);
            return {
                jobId,
                jobName: jobRuns[0].jobName ?? jobId,
                ...summarize(jobRuns),
                recent: jobRuns.slice(0, RECENT_RUNS).map((r) => ({
                    status: r.status,
                    startedAt: new Date(r.startedAt).toISOString(),
                    duration: typeof r.duration === 'number' ? r.duration : null,
                })),
            };
        });

    return {
        since: range.since.toISOString(),
        until: range.until.toISOString(),
        bucketMs: range.bucketMs,
        buckets,
        totals: summarize(runs),
        jobs,
    };
}

function newestFirst(a: JobExecution, b: JobExecution): number {
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
}

/** Counts, success rate and durations (finished runs only) of a set of runs. */
export function summarize(runs: JobExecution[]): JobRunSummary {
    const counts = { succeeded: 0, failed: 0, cancelled: 0, running: 0 };
    const durations: number[] = [];
    let lastFailure: number | undefined;
    for (const run of runs) {
        const outcome = jobRunOutcome(run.status);
        counts[outcome]++;
        if (outcome !== 'running' && typeof run.duration === 'number' && Number.isFinite(run.duration)) {
            durations.push(run.duration);
        }
        if (outcome === 'failed') {
            const at = new Date(run.startedAt).getTime();
            if (lastFailure === undefined || at > lastFailure) lastFailure = at;
        }
    }
    durations.sort((a, b) => a - b);
    const decided = counts.succeeded + counts.failed;
    return {
        total: runs.length,
        ...counts,
        successRate: decided === 0 ? null : round(counts.succeeded / decided, 3),
        avgDuration: durations.length === 0 ? null : round(durations.reduce((s, d) => s + d, 0) / durations.length, 1),
        p95Duration: durations.length === 0 ? null : durations[Math.ceil(0.95 * durations.length) - 1],
        maxDuration: durations.length === 0 ? null : durations[durations.length - 1],
        lastFailureAt: lastFailure === undefined ? null : new Date(lastFailure).toISOString(),
    };
}

function round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
