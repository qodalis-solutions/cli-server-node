import { JobExecution, JobExecutionStatus } from './job-execution';
import { JobState } from './job-state';

export interface ICliJobStorageProvider {
    saveExecution(execution: JobExecution): Promise<void>;
    getExecutions(
        jobId: string,
        options?: { limit?: number; offset?: number; status?: JobExecutionStatus },
    ): Promise<{ items: JobExecution[]; total: number }>;
    getExecution(executionId: string): Promise<JobExecution | null>;
    saveJobState(jobId: string, state: JobState): Promise<void>;
    getJobState(jobId: string): Promise<JobState | null>;
    getAllJobStates(): Promise<Map<string, JobState>>;
}
