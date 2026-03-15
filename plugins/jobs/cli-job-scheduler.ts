import { randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import {
    ICliJob,
    CliJobOptions,
    ICliJobStorageProvider,
    JobExecution,
    JobState,
    JobStatus,
    JobExecutionStatus,
} from '@qodalis/cli-server-abstractions';
import { CliJobExecutionContext } from './cli-job-execution-context';
import { parseInterval } from './interval-parser';

export interface JobRegistration {
    id: string;
    job: ICliJob;
    options: CliJobOptions;
    status: JobStatus;
    currentExecutionId?: string;
    currentAbortController?: AbortController;
    nextRunAt?: string;
    lastRunAt?: string;
    lastRunStatus?: string;
    lastRunDuration?: number;
    timer?: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
    timerType?: 'cron' | 'interval';
    /** Queued executions for overlap policy 'queue' */
    queue: Array<{ resolve: () => void }>;
}

export interface JobDto {
    id: string;
    name: string;
    description: string;
    group?: string;
    status: JobStatus;
    schedule?: string;
    interval?: string;
    enabled: boolean;
    maxRetries: number;
    timeout?: string;
    overlapPolicy: string;
    currentExecutionId?: string;
    nextRunAt?: string;
    lastRunAt?: string;
    lastRunStatus?: string;
    lastRunDuration?: number;
}

type BroadcastFn = (message: Record<string, unknown>) => void;

export class CliJobScheduler {
    private readonly _registrations = new Map<string, JobRegistration>();
    private readonly _storage: ICliJobStorageProvider;
    private _broadcastFn: BroadcastFn | null = null;
    private _running = false;

    constructor(storage: ICliJobStorageProvider) {
        this._storage = storage;
    }

    setBroadcastFn(fn: BroadcastFn): void {
        this._broadcastFn = fn;
    }

    register(job: ICliJob, options: CliJobOptions): string {
        const id = randomUUID();
        const enabled = options.enabled !== false;
        const reg: JobRegistration = {
            id,
            job,
            options: { ...options, enabled },
            status: enabled ? 'active' : 'stopped',
            queue: [],
        };
        this._registrations.set(id, reg);
        return id;
    }

    async start(): Promise<void> {
        this._running = true;

        // Load persisted states
        const states = await this._storage.getAllJobStates();
        for (const [id, reg] of this._registrations) {
            const persisted = states.get(id);
            if (persisted) {
                reg.status = persisted.status;
                reg.lastRunAt = persisted.lastRunAt;
            }

            if (reg.status === 'active') {
                this._startTimer(reg);
            }
        }
    }

    async stop(): Promise<void> {
        this._running = false;

        // Cancel all running executions and stop timers
        for (const reg of this._registrations.values()) {
            this._stopTimer(reg);

            if (reg.currentAbortController) {
                reg.currentAbortController.abort();
            }

            // Persist state
            await this._storage.saveJobState(reg.id, {
                status: reg.status,
                lastRunAt: reg.lastRunAt,
                updatedAt: new Date().toISOString(),
            });
        }
    }

    getAll(): JobDto[] {
        return Array.from(this._registrations.values()).map((reg) => this._toDto(reg));
    }

    get(id: string): JobDto | undefined {
        const reg = this._registrations.get(id);
        return reg ? this._toDto(reg) : undefined;
    }

    getRegistration(id: string): JobRegistration | undefined {
        return this._registrations.get(id);
    }

    async triggerAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);

        if (reg.currentExecutionId) {
            const policy = reg.options.overlapPolicy ?? 'skip';
            if (policy === 'skip') {
                throw new JobError('Job is already running', 'JOB_ALREADY_RUNNING', 409);
            }
            if (policy === 'cancel') {
                reg.currentAbortController?.abort();
                // Wait briefly for cancellation
                await new Promise((r) => setTimeout(r, 50));
            }
            if (policy === 'queue') {
                return new Promise<void>((resolve) => {
                    reg.queue.push({ resolve });
                });
            }
        }

        await this._executeJobAsync(reg, 0);
    }

    async pauseAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);
        if (reg.status === 'paused') throw new JobError('Job is already paused', 'JOB_ALREADY_PAUSED', 409);

        reg.status = 'paused';
        this._stopTimer(reg);
        await this._persistState(reg);
        this._broadcast({ type: 'job:paused', jobId: reg.id });
    }

    async resumeAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);
        if (reg.status !== 'paused') throw new JobError('Job is not paused', 'JOB_NOT_PAUSED', 409);

        reg.status = 'active';
        this._startTimer(reg);
        await this._persistState(reg);
        this._broadcast({ type: 'job:resumed', jobId: reg.id });
    }

    async stopJobAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);

        reg.status = 'stopped';
        this._stopTimer(reg);

        if (reg.currentAbortController) {
            reg.currentAbortController.abort();
        }

        await this._persistState(reg);
        this._broadcast({ type: 'job:stopped', jobId: reg.id });
    }

    async cancelCurrentAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);
        if (!reg.currentExecutionId) throw new JobError('No execution is running', 'JOB_NOT_RUNNING', 409);

        reg.currentAbortController?.abort();
    }

    async updateOptionsAsync(
        id: string,
        updates: Partial<Pick<CliJobOptions, 'description' | 'group' | 'schedule' | 'interval' | 'maxRetries' | 'timeout' | 'overlapPolicy'>>,
    ): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);

        // Validate: can't provide both schedule and interval
        if (updates.schedule !== undefined && updates.interval !== undefined && updates.schedule !== null && updates.interval !== null) {
            throw new JobError('Cannot provide both schedule and interval', 'SCHEDULE_CONFLICT', 400);
        }

        // Validate schedule if provided
        if (updates.schedule !== undefined && updates.schedule !== null) {
            try {
                CronExpressionParser.parse(updates.schedule);
            } catch {
                throw new JobError('Invalid cron expression', 'INVALID_SCHEDULE', 400);
            }
        }

        // Validate interval if provided
        if (updates.interval !== undefined && updates.interval !== null) {
            const ms = parseInterval(updates.interval);
            if (ms === null) {
                throw new JobError('Invalid interval format', 'INVALID_SCHEDULE', 400);
            }
        }

        // Apply updates
        if (updates.description !== undefined) reg.options.description = updates.description;
        if (updates.group !== undefined) reg.options.group = updates.group;
        if (updates.maxRetries !== undefined) reg.options.maxRetries = updates.maxRetries;
        if (updates.timeout !== undefined) reg.options.timeout = updates.timeout;
        if (updates.overlapPolicy !== undefined) reg.options.overlapPolicy = updates.overlapPolicy;

        // Handle schedule/interval changes (setting one clears the other)
        if (updates.schedule !== undefined) {
            if (updates.schedule === null) {
                reg.options.schedule = undefined;
            } else {
                reg.options.schedule = updates.schedule;
                reg.options.interval = undefined;
            }
        }
        if (updates.interval !== undefined) {
            if (updates.interval === null) {
                reg.options.interval = undefined;
            } else {
                reg.options.interval = updates.interval;
                reg.options.schedule = undefined;
            }
        }

        // Restart timer if active
        if (reg.status === 'active') {
            this._stopTimer(reg);
            this._startTimer(reg);
        }
    }

    get storage(): ICliJobStorageProvider {
        return this._storage;
    }

    // ── Private ────────────────────────────────────────────────────

    private _toDto(reg: JobRegistration): JobDto {
        return {
            id: reg.id,
            name: reg.options.name ?? 'unnamed',
            description: reg.options.description ?? reg.options.name ?? 'unnamed',
            group: reg.options.group,
            status: reg.status,
            schedule: reg.options.schedule,
            interval: reg.options.interval,
            enabled: reg.options.enabled !== false,
            maxRetries: reg.options.maxRetries ?? 0,
            timeout: reg.options.timeout,
            overlapPolicy: reg.options.overlapPolicy ?? 'skip',
            currentExecutionId: reg.currentExecutionId,
            nextRunAt: reg.nextRunAt,
            lastRunAt: reg.lastRunAt,
            lastRunStatus: reg.lastRunStatus,
            lastRunDuration: reg.lastRunDuration,
        };
    }

    private _startTimer(reg: JobRegistration): void {
        if (reg.options.schedule) {
            this._startCronTimer(reg);
        } else if (reg.options.interval) {
            this._startIntervalTimer(reg);
        }
    }

    private _startCronTimer(reg: JobRegistration): void {
        const scheduleNext = () => {
            if (!this._running || reg.status !== 'active') return;

            try {
                const expr = CronExpressionParser.parse(reg.options.schedule!);
                const next = expr.next();
                const nextDate = next.toDate();
                reg.nextRunAt = nextDate.toISOString();

                const delay = nextDate.getTime() - Date.now();
                reg.timer = setTimeout(async () => {
                    if (reg.status !== 'active' || !this._running) return;
                    await this._handleTimerFire(reg);
                    scheduleNext();
                }, Math.max(delay, 0));
                reg.timerType = 'cron';
            } catch {
                // Invalid cron expression — stop scheduling
            }
        };

        scheduleNext();
    }

    private _startIntervalTimer(reg: JobRegistration): void {
        const ms = parseInterval(reg.options.interval!);
        if (ms === null) return;

        reg.nextRunAt = new Date(Date.now() + ms).toISOString();
        reg.timer = setInterval(async () => {
            if (reg.status !== 'active' || !this._running) return;
            await this._handleTimerFire(reg);
            reg.nextRunAt = new Date(Date.now() + ms).toISOString();
        }, ms);
        reg.timerType = 'interval';
    }

    private async _handleTimerFire(reg: JobRegistration): Promise<void> {
        if (reg.currentExecutionId) {
            const policy = reg.options.overlapPolicy ?? 'skip';
            if (policy === 'skip') return;
            if (policy === 'cancel') {
                reg.currentAbortController?.abort();
                await new Promise((r) => setTimeout(r, 50));
            }
            if (policy === 'queue') {
                return new Promise<void>((resolve) => {
                    reg.queue.push({ resolve });
                });
            }
        }

        await this._executeJobAsync(reg, 0);
    }

    private async _executeJobAsync(reg: JobRegistration, retryAttempt: number): Promise<void> {
        const executionId = randomUUID();
        const abortController = new AbortController();

        reg.currentExecutionId = executionId;
        reg.currentAbortController = abortController;

        const execution: JobExecution = {
            id: executionId,
            jobId: reg.id,
            jobName: reg.options.name ?? 'unnamed',
            status: 'running',
            startedAt: new Date().toISOString(),
            logs: [],
            retryAttempt,
        };

        await this._storage.saveExecution(execution);
        this._broadcast({
            type: 'job:started',
            jobId: reg.id,
            executionId,
            timestamp: execution.startedAt,
        });

        const context = new CliJobExecutionContext();
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

        // Set up timeout
        if (reg.options.timeout) {
            const timeoutMs = parseInterval(reg.options.timeout);
            if (timeoutMs !== null) {
                timeoutTimer = setTimeout(() => {
                    abortController.abort();
                }, timeoutMs);
            }
        }

        let finalStatus: JobExecutionStatus = 'completed';
        let error: string | undefined;

        try {
            await reg.job.executeAsync(context, abortController.signal);

            if (abortController.signal.aborted) {
                // Determine if this was a timeout or manual cancel
                finalStatus = timeoutTimer ? 'timed_out' : 'cancelled';
            }
        } catch (err: unknown) {
            if (abortController.signal.aborted) {
                finalStatus = timeoutTimer ? 'timed_out' : 'cancelled';
            } else {
                finalStatus = 'failed';
                error = err instanceof Error ? err.message : String(err);
            }
        } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer);
        }

        const completedAt = new Date();
        const duration = completedAt.getTime() - new Date(execution.startedAt).getTime();

        execution.status = finalStatus;
        execution.completedAt = completedAt.toISOString();
        execution.duration = duration;
        execution.error = error;
        execution.logs = context.logEntries;

        await this._storage.saveExecution(execution);

        reg.currentExecutionId = undefined;
        reg.currentAbortController = undefined;
        reg.lastRunAt = execution.startedAt;
        reg.lastRunStatus = finalStatus;
        reg.lastRunDuration = duration;

        // Persist state
        await this._persistState(reg);

        // Broadcast completion event
        if (finalStatus === 'completed') {
            this._broadcast({ type: 'job:completed', jobId: reg.id, executionId, duration });
        } else if (finalStatus === 'failed') {
            this._broadcast({ type: 'job:failed', jobId: reg.id, executionId, error });
        } else if (finalStatus === 'cancelled') {
            this._broadcast({ type: 'job:cancelled', jobId: reg.id, executionId });
        } else if (finalStatus === 'timed_out') {
            this._broadcast({ type: 'job:timed_out', jobId: reg.id, executionId, timeout: reg.options.timeout });
        }

        // Handle retry on failure
        if (finalStatus === 'failed' && retryAttempt < (reg.options.maxRetries ?? 0)) {
            await this._executeJobAsync(reg, retryAttempt + 1);
            return;
        }

        // Process queue
        if (reg.queue.length > 0) {
            const next = reg.queue.shift()!;
            next.resolve();
            await this._executeJobAsync(reg, 0);
        }
    }

    private _stopTimer(reg: JobRegistration): void {
        if (reg.timer !== undefined) {
            if (reg.timerType === 'interval') {
                clearInterval(reg.timer);
            } else {
                clearTimeout(reg.timer);
            }
            reg.timer = undefined;
            reg.timerType = undefined;
        }
        reg.nextRunAt = undefined;
    }

    private async _persistState(reg: JobRegistration): Promise<void> {
        await this._storage.saveJobState(reg.id, {
            status: reg.status,
            lastRunAt: reg.lastRunAt,
            updatedAt: new Date().toISOString(),
        });
    }

    private _broadcast(message: Record<string, unknown>): void {
        if (this._broadcastFn) {
            this._broadcastFn(message);
        }
    }
}

export class JobError extends Error {
    readonly code: string;
    readonly statusCode: number;

    constructor(message: string, code: string, statusCode: number) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.name = 'JobError';
    }
}
