export type JobStatus = 'active' | 'paused' | 'stopped';

export interface JobState {
    status: JobStatus;
    lastRunAt?: string;
    updatedAt: string;
}
