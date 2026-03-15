import { JobLogEntry } from './log-entry';

export type JobExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface JobExecution {
    id: string;
    jobId: string;
    jobName: string;
    status: JobExecutionStatus;
    startedAt: string;
    completedAt?: string;
    duration?: number;
    error?: string;
    logs: JobLogEntry[];
    retryAttempt: number;
}
