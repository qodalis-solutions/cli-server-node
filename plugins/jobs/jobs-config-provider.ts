import { CliStoredConfigProvider, type CliConfigValue } from '@qodalis/cli-server-abstractions';
import type { CliJobScheduler } from './cli-job-scheduler';
import { formatDuration, parseDuration } from './interval-parser';

type LimitKey = 'maxAge' | 'maxRunsPerJob' | 'failedMaxAge' | 'failedMaxRunsPerJob';

/**
 * `jobs`: the history retention every job gets (unless it sets its own), changeable at runtime;
 * the next `jobs:prune-history` run applies it. The prune interval is set in code.
 */
export function createJobsConfigProvider(scheduler: CliJobScheduler): CliStoredConfigProvider {
    const initial = scheduler.historyDefaults;
    const asDuration = (value: unknown): string | null => {
        if (value === undefined || value === null) return null;
        const ms = parseDuration(value as string | number);
        return ms === null ? null : formatDuration(ms);
    };
    const apply = (key: LimitKey) => (value: CliConfigValue) => {
        const limits = { ...scheduler.historyDefaults };
        if (value === null || value === undefined) delete limits[key];
        else (limits as Record<string, unknown>)[key] = value;
        scheduler.setHistoryDefaults(limits);
    };
    const durationRule = (value: CliConfigValue) => (parseDuration(value as string) === null ? "must be a duration in s, m, h or d (e.g. '30d')" : undefined);
    const countRule = (value: CliConfigValue) => (Number.isInteger(value) ? undefined : 'must be a whole number');
    return new CliStoredConfigProvider({
        id: 'jobs',
        title: 'Jobs',
        description: 'Defaults of the background jobs',
        order: 60,
        sections: [
            {
                id: 'history',
                title: 'Run history retention',
                description: 'Applied to every job without its own history options by the jobs:prune-history job; empty keeps every run',
                settings: [
                    {
                        key: 'maxAge',
                        label: 'Keep runs for',
                        description: 'Delete runs that started longer ago than this',
                        type: 'duration',
                        default: asDuration(initial.maxAge),
                        validation: { min: 1000 },
                        validate: durationRule,
                        apply: apply('maxAge'),
                    },
                    {
                        key: 'maxRunsPerJob',
                        label: 'Runs kept per job',
                        description: 'Keep at most this many runs per job, the newest',
                        type: 'number',
                        default: initial.maxRunsPerJob ?? null,
                        validation: { min: 1 },
                        validate: countRule,
                        apply: apply('maxRunsPerJob'),
                    },
                    {
                        key: 'failedMaxAge',
                        label: 'Keep failed runs for',
                        description: 'Delete failed runs that started longer ago than this (default: Keep runs for)',
                        type: 'duration',
                        default: asDuration(initial.failedMaxAge),
                        validation: { min: 1000 },
                        validate: durationRule,
                        apply: apply('failedMaxAge'),
                    },
                    {
                        key: 'failedMaxRunsPerJob',
                        label: 'Failed runs kept per job',
                        description: 'Keep at most this many failed runs per job, counted on their own',
                        type: 'number',
                        default: initial.failedMaxRunsPerJob ?? null,
                        validation: { min: 1 },
                        validate: countRule,
                        apply: apply('failedMaxRunsPerJob'),
                    },
                    {
                        key: 'pruneInterval',
                        label: 'Prune every',
                        description: 'How often jobs:prune-history runs (set in code)',
                        type: 'duration',
                        mutable: false,
                        requiresRestart: true,
                        default: formatDuration(scheduler.historyPruneIntervalMs),
                    },
                ],
            },
        ],
    });
}
