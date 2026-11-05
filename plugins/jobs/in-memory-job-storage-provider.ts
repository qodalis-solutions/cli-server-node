import {
    ICliJobStorageProvider,
    JobExecution,
    JobExecutionQuery,
    JobExecutionStatus,
    JobState,
    matchesJobExecutionQuery,
} from '@qodalis/cli-server-abstractions';

/** Volatile, in-memory storage for job executions and state (lost on restart). */
export class InMemoryJobStorageProvider implements ICliJobStorageProvider {
    private readonly _executions = new Map<string, JobExecution>();
    /** jobId -> execution IDs in insertion order */
    private readonly _jobExecutions = new Map<string, string[]>();
    private readonly _jobStates = new Map<string, JobState>();

    async saveExecution(execution: JobExecution): Promise<void> {
        this._executions.set(execution.id, { ...execution });

        let list = this._jobExecutions.get(execution.jobId);
        if (!list) {
            list = [];
            this._jobExecutions.set(execution.jobId, list);
        }
        if (!list.includes(execution.id)) {
            list.push(execution.id);
        }
    }

    async getExecutions(
        jobId: string,
        options?: { limit?: number; offset?: number; status?: JobExecutionStatus },
    ): Promise<{ items: JobExecution[]; total: number }> {
        const ids = this._jobExecutions.get(jobId) ?? [];
        let executions = ids
            .map((id) => this._executions.get(id)!)
            .filter(Boolean)
            .reverse(); // newest first

        if (options?.status) {
            executions = executions.filter((e) => e.status === options.status);
        }

        const total = executions.length;
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? 20;
        const items = executions.slice(offset, offset + limit);

        return { items, total };
    }

    async queryExecutions(query: JobExecutionQuery): Promise<{ items: JobExecution[]; total: number }> {
        const jobIds = query.jobIds ? new Set(query.jobIds) : undefined;
        const matches = Array.from(this._executions.values())
            .filter((e) => (!jobIds || jobIds.has(e.jobId)) && matchesJobExecutionQuery(e, query))
            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 20;
        return { items: matches.slice(offset, offset + limit), total: matches.length };
    }

    async prune(before: Date): Promise<number> {
        let removed = 0;
        for (const execution of Array.from(this._executions.values())) {
            if (new Date(execution.startedAt).getTime() < before.getTime() && this._remove(execution.id)) {
                removed++;
            }
        }
        return removed;
    }

    async deleteExecution(executionId: string): Promise<boolean> {
        return this._remove(executionId);
    }

    async getExecution(executionId: string): Promise<JobExecution | null> {
        return this._executions.get(executionId) ?? null;
    }

    async saveJobState(jobId: string, state: JobState): Promise<void> {
        this._jobStates.set(jobId, { ...state });
    }

    async getJobState(jobId: string): Promise<JobState | null> {
        return this._jobStates.get(jobId) ?? null;
    }

    async getAllJobStates(): Promise<Map<string, JobState>> {
        return new Map(this._jobStates);
    }

    private _remove(executionId: string): boolean {
        const execution = this._executions.get(executionId);
        if (!execution) return false;
        this._executions.delete(executionId);
        const list = this._jobExecutions.get(execution.jobId);
        const index = list?.indexOf(executionId) ?? -1;
        if (list && index >= 0) list.splice(index, 1);
        return true;
    }
}
