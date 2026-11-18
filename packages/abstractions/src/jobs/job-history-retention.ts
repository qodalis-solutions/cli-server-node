/** A duration: a string like "30s", "5m", "6h", "30d", or milliseconds. */
export type JobDuration = string | number;

/**
 * Limits of a job's run history. A run is deleted when it breaks any limit that is set;
 * failed runs use the `failed*` limits when set, else the normal ones. Running runs and
 * the latest run of each job are never deleted.
 */
export interface JobHistoryLimits {
    /** Delete runs that started longer ago than this. */
    maxAge?: JobDuration;
    /** Keep at most this many runs per job, the newest (integer >= 1). */
    maxRunsPerJob?: number;
    /** Delete failed runs that started longer ago than this (default `maxAge`). */
    failedMaxAge?: JobDuration;
    /**
     * Keep at most this many failed runs per job (integer >= 1). When set, failed runs are
     * counted on their own and the other runs against `maxRunsPerJob`; else every run counts
     * against `maxRunsPerJob`.
     */
    failedMaxRunsPerJob?: number;
}

/** The jobs plugin's history retention (opt-in): the limits of every job, and how often to prune. */
export interface CliJobsHistoryOptions extends JobHistoryLimits {
    /** How often the `jobs:prune-history` job runs. Default 1 day. */
    pruneInterval?: JobDuration;
}

/** A job's own history limits: a set field replaces the global one for that job. */
export interface CliJobHistoryOptions extends JobHistoryLimits {
    /** Keep every run of this job, whatever the limits. */
    keepAll?: boolean;
}

/** Effective limits of one job, durations in milliseconds; an unset limit is undefined. */
export interface JobHistoryRule {
    maxAgeMs?: number;
    maxRuns?: number;
    failedMaxAgeMs?: number;
    failedMaxRuns?: number;
}

/** What {@link ICliJobStorageProvider.pruneHistory} deletes. */
export interface JobHistoryRetention {
    /** The time the age limits count from. */
    now: Date;
    /** The limits of each job by id; `null` keeps every run of that job. */
    jobs: Record<string, JobHistoryRule | null>;
    /** The limits of the jobs not in `jobs` (no longer registered); absent keeps their runs. */
    defaults?: JobHistoryRule;
}

/** The rule of `jobId` under `retention`, or null when its runs are all kept. */
export function jobHistoryRuleFor(retention: JobHistoryRetention, jobId: string): JobHistoryRule | null {
    if (Object.prototype.hasOwnProperty.call(retention.jobs, jobId)) return retention.jobs[jobId];
    return retention.defaults ?? null;
}

/**
 * The runs of one job that break `rule`, given the job's runs newest first (by `startedAt`).
 * Never a running run or the newest run. Storage providers that hold runs in memory use it;
 * database providers should delete set-based instead.
 */
export function selectRunsBreakingRetention<T extends { status: string; startedAt: string }>(
    runsNewestFirst: T[],
    rule: JobHistoryRule,
    now: Date,
): T[] {
    const result: T[] = [];
    let failedRank = 0;
    let otherRank = 0;
    runsNewestFirst.forEach((run, index) => {
        const failed = run.status === 'failed';
        // Separate counts only when failed runs have their own count limit
        const rank = failed && rule.failedMaxRuns !== undefined ? failedRank++ : otherRank++;
        if (index === 0 || run.status === 'running') return;
        const maxAge = failed ? (rule.failedMaxAgeMs ?? rule.maxAgeMs) : rule.maxAgeMs;
        const maxRuns = failed ? (rule.failedMaxRuns ?? rule.maxRuns) : rule.maxRuns;
        const tooOld = maxAge !== undefined && now.getTime() - Date.parse(run.startedAt) > maxAge;
        const tooMany = maxRuns !== undefined && rank >= maxRuns;
        if (tooOld || tooMany) result.push(run);
    });
    return result;
}
