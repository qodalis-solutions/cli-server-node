import { randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import {
    CliEventPermissions,
    ICliEventBus,
    cliEventBusFromBroadcast,
    ICliJob,
    CliJobOptions,
    ICliJobStorageProvider,
    JobExecution,
    JobState,
    JobStatus,
    JobExecutionStatus,
    JobExecutionQuery,
    mergeJobExecutions,
    deleteJobExecution,
} from '@qodalis/cli-server-abstractions';
import { CliJobExecutionContext } from './cli-job-execution-context';
import { parseInterval } from './interval-parser';

/** Characters a job id may not have: it is part of the jobs API's URLs. */
const UNSAFE_ID_CHARS = /[/\\?#]/;

/** Internal state for a registered job, including timers and execution queue. */
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

/** Data transfer object exposing job metadata and current state to API consumers. */
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
    retryDelay: string;
    retryStrategy: string;
    timeout?: string;
    overlapPolicy: string;
    currentExecutionId?: string;
    nextRunAt?: string;
    lastRunAt?: string;
    lastRunStatus?: string;
    lastRunDuration?: number;
}

type BroadcastFn = (message: Record<string, unknown>) => void;

/** Options of a job that `updateOptionsAsync` may change. */
export type CliJobOptionsUpdate = Partial<Pick<CliJobOptions, 'description' | 'group' | 'schedule' | 'interval' | 'maxRetries' | 'retryDelay' | 'retryStrategy' | 'timeout' | 'overlapPolicy'>>;

/**
 * The scheduler that runs the jobs registered in this process: their
 * registrations and the actions on them. Use it (`jobsPlugin.scheduler`) to act on
 * a job from the host's own code, e.g. run a job when something happened.
 */
export interface ICliJobScheduler {
    /** The registered jobs keyed by job id, in registration order. */
    readonly jobs: ReadonlyMap<string, JobRegistration>;
    /** Runs the job now; throws a {@link JobError} (409) when it is running and may not overlap. */
    triggerAsync(id: string): Promise<void>;
    /** Pauses the job's schedule. */
    pauseAsync(id: string): Promise<void>;
    /** Resumes a paused job's schedule. */
    resumeAsync(id: string): Promise<void>;
    /** Stops the job: cancels a running execution and disables its schedule. */
    stopJobAsync(id: string): Promise<void>;
    /** Cancels the job's running execution. */
    cancelCurrentAsync(id: string): Promise<void>;
    /** Changes the job's options and restarts its schedule. */
    updateOptionsAsync(id: string, updates: CliJobOptionsUpdate): Promise<void>;
    /** The executions of several jobs (`query.jobIds`) or of every job, newest first. */
    queryExecutions(query: JobExecutionQuery): Promise<{ items: JobExecution[]; total: number }>;
    /**
     * Deletes one finished run of the job and its logs. Throws a {@link JobError}: 404 `JOB_NOT_FOUND`,
     * 404 `EXECUTION_NOT_FOUND` (missing or another job's run), 409 `EXECUTION_RUNNING`, 501 `NOT_SUPPORTED`
     * (the storage cannot delete runs).
     */
    deleteExecutionAsync(jobId: string, executionId: string): Promise<void>;
    /**
     * Deletes every finished run of the job, or only those with `status` (matched like the history filter);
     * running runs are never deleted. Returns how many were deleted. Throws like {@link deleteExecutionAsync}.
     */
    deleteExecutionsAsync(jobId: string, status?: string): Promise<number>;
}

/** A job's runs read per page by {@link deleteFinishedJobExecutions}. */
const DELETE_PAGE_SIZE = 100;

/**
 * The default bulk delete of a job scheduler: lists the job's runs page by page (with `status`), then deletes each
 * finished one through `deleteOne`, skipping runs that are running (or started running since they were listed).
 * Returns how many were deleted.
 */
export async function deleteFinishedJobExecutions(
    listPage: (offset: number, limit: number) => Promise<{ items: JobExecution[]; total: number }>,
    deleteOne: (executionId: string) => Promise<void>,
): Promise<number> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += DELETE_PAGE_SIZE) {
        const page = await listPage(offset, DELETE_PAGE_SIZE);
        ids.push(...page.items.filter((e) => e.status !== 'running').map((e) => e.id));
        if (page.items.length < DELETE_PAGE_SIZE || offset + DELETE_PAGE_SIZE >= page.total) break;
    }
    let deleted = 0;
    for (const id of ids) {
        try {
            await deleteOne(id);
            deleted++;
        } catch (err) {
            // Started running, or deleted by someone else, since it was listed
            if (err instanceof JobError && (err.code === 'EXECUTION_RUNNING' || err.code === 'EXECUTION_NOT_FOUND')) continue;
            throw err;
        }
    }
    return deleted;
}

/**
 * Manages job registration, scheduling (cron / interval), execution with
 * retry logic, overlap policies, and state persistence.
 */
export class CliJobScheduler implements ICliJobScheduler {
    private readonly _registrations = new Map<string, JobRegistration>();
    private readonly _storage: ICliJobStorageProvider;
    private _eventBus: ICliEventBus | null = null;
    private _running = false;

    constructor(storage: ICliJobStorageProvider) {
        this._storage = storage;
    }

    /**
     * Sends job lifecycle events through a raw broadcast function (kept for compatibility;
     * prefer {@link setEventBus}).
     */
    setBroadcastFn(fn: BroadcastFn): void {
        this._eventBus = cliEventBusFromBroadcast(fn);
    }

    /** Publishes the job lifecycle events (`job:*`, audience `jobs:read`) on `eventBus`. */
    setEventBus(eventBus: ICliEventBus | undefined): void {
        this._eventBus = eventBus ?? null;
    }

    /** The bus job events are published on (also used by the jobs API for `job:triggered`, ...). */
    get eventBus(): ICliEventBus | undefined {
        return this._eventBus ?? undefined;
    }

    /**
     * Publishes a job event (audience `jobs:read`). The jobs API and the MCP tools publish
     * `job:triggered`, `job:updated` and `job:runs-deleted` through it.
     */
    publishEvent(type: string, data: Record<string, unknown>): Promise<void> {
        return this._eventBus?.publish(type, data, { permission: CliEventPermissions.JobsRead }) ?? Promise.resolve();
    }

    /**
     * Register a job with the scheduler.
     *
     * @param job - The job implementation.
     * @param options - Scheduling and retry configuration.
     * @returns The job ID: `options.id`, else the name (`name-2`, `name-3`, ... for
     *   further jobs of the same name). Stable across restarts, so saved state and
     *   history find the job again.
     * @throws {Error} When `options.id` is empty, has `/`, `\\`, `?` or `#` (it is part of the jobs API's URLs; a
     * default id replaces them with `-`), or is already registered.
     */
    register(job: ICliJob, options: CliJobOptions): string {
        const name = options.name ?? (job.constructor?.name && job.constructor.name !== 'Object' ? job.constructor.name : 'job');
        let id: string;
        if (options.id !== undefined) {
            if (!options.id.trim() || UNSAFE_ID_CHARS.test(options.id)) {
                throw new Error(
                    `Job id '${options.id}' must be non-empty and may not contain '/', '\\', '?' or '#' (it is part of the jobs API's URLs)`,
                );
            }
            if (this._registrations.has(options.id)) {
                throw new Error(`A job with id '${options.id}' is already registered`);
            }
            id = options.id;
        } else {
            const baseId = name.replace(new RegExp(UNSAFE_ID_CHARS.source, 'g'), '-');
            id = baseId;
            for (let n = 2; this._registrations.has(id); n++) id = `${baseId}-${n}`;
        }
        const enabled = options.enabled !== false;
        const reg: JobRegistration = {
            id,
            job,
            options: { ...options, name, enabled },
            status: enabled ? 'active' : 'stopped',
            queue: [],
        };
        this._registrations.set(id, reg);
        return id;
    }

    /** Load persisted job states and start timers for all active jobs. */
    async start(): Promise<void> {
        this._running = true;

        // Load persisted states
        const states = await this._storage.getAllJobStates();
        for (const [id, reg] of this._registrations) {
            // Restore the last run, and a pause or stop made at run time; a job the code disables
            // (enabled: false) stays stopped whatever was saved.
            const persisted = states.get(id);
            if (persisted) {
                reg.lastRunAt = persisted.lastRunAt;
                if (reg.options.enabled !== false) reg.status = persisted.status;
            }

            if (reg.status === 'active') {
                // An interval job runs on start through its timer (due now), so the two never overlap
                const runNow = !!reg.options.runOnStart && !reg.options.schedule && !!reg.options.interval;
                this._startTimer(reg, runNow);

                if (reg.options.runOnStart && !runNow) {
                    this._handleTimerFire(reg).catch(() => undefined);
                }
            }
        }
    }

    /** Stop all timers, cancel running executions, and persist final states. */
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

    /** The registered jobs keyed by job id, in registration order. */
    get jobs(): ReadonlyMap<string, JobRegistration> {
        return this._registrations;
    }

    /**
     * The executions of several jobs (`query.jobIds`) or of every registered job,
     * newest first: the storage's own `queryExecutions`, else its per-job listings merged.
     */
    async queryExecutions(query: JobExecutionQuery): Promise<{ items: JobExecution[]; total: number }> {
        if (this._storage.queryExecutions) return this._storage.queryExecutions(query);
        const jobIds = query.jobIds ?? Array.from(this._registrations.keys());
        return mergeJobExecutions(query, jobIds, (jobId, limit, status) =>
            this._storage.getExecutions(jobId, { limit, offset: 0, status }),
        );
    }

    /** Return DTOs for all registered jobs. */
    getAll(): JobDto[] {
        return Array.from(this._registrations.values()).map((reg) => this._toDto(reg));
    }

    /** Return the DTO for a single job, or `undefined` if not found. */
    get(id: string): JobDto | undefined {
        const reg = this._registrations.get(id);
        return reg ? this._toDto(reg) : undefined;
    }

    /** Return the internal registration for a job (used by the controller for history lookups). */
    getRegistration(id: string): JobRegistration | undefined {
        return this._registrations.get(id);
    }

    /**
     * Trigger an immediate execution of a job, respecting the configured overlap policy.
     *
     * @throws {JobError} If the job is not found or is already running with a 'skip' policy.
     */
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

    /** Pause a running job's schedule without cancelling the current execution. */
    async pauseAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);
        if (reg.status === 'paused') throw new JobError('Job is already paused', 'JOB_ALREADY_PAUSED', 409);

        reg.status = 'paused';
        this._stopTimer(reg);
        await this._persistState(reg);
        this._broadcast({ type: 'job:paused', jobId: reg.id, status: reg.status });
    }

    /** Resume a paused job, restarting its schedule timer. */
    async resumeAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);
        if (reg.status !== 'paused') throw new JobError('Job is not paused', 'JOB_NOT_PAUSED', 409);

        reg.status = 'active';
        this._startTimer(reg);
        await this._persistState(reg);
        this._broadcast({ type: 'job:resumed', jobId: reg.id, status: reg.status });
    }

    /** Stop a job entirely, cancelling any running execution and clearing its timer. */
    async stopJobAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);

        reg.status = 'stopped';
        this._stopTimer(reg);

        if (reg.currentAbortController) {
            reg.currentAbortController.abort();
        }

        await this._persistState(reg);
        this._broadcast({ type: 'job:stopped', jobId: reg.id, status: reg.status });
    }

    /** Cancel the currently running execution of a job without changing its schedule. */
    async cancelCurrentAsync(id: string): Promise<void> {
        const reg = this._registrations.get(id);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);
        if (!reg.currentExecutionId) throw new JobError('No execution is running', 'JOB_NOT_RUNNING', 409);

        reg.currentAbortController?.abort();
    }

    /** Delete one finished run of a job and its logs (see {@link ICliJobScheduler.deleteExecutionAsync}). */
    async deleteExecutionAsync(jobId: string, executionId: string): Promise<void> {
        const reg = this._registrations.get(jobId);
        if (!reg) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);
        if (!this._storage.deleteExecution) {
            throw new JobError('The job storage cannot delete runs', 'NOT_SUPPORTED', 501);
        }
        const execution = await this._storage.getExecution(executionId);
        if (!execution || execution.jobId !== jobId) {
            throw new JobError('Execution not found', 'EXECUTION_NOT_FOUND', 404);
        }
        if (execution.status === 'running' || reg.currentExecutionId === executionId) {
            throw new JobError('The run is still running', 'EXECUTION_RUNNING', 409);
        }
        if (!(await this._storage.deleteExecution(executionId))) {
            throw new JobError('Execution not found', 'EXECUTION_NOT_FOUND', 404);
        }
    }

    /** Delete every finished run of a job, or those with `status` (see {@link ICliJobScheduler.deleteExecutionsAsync}). */
    async deleteExecutionsAsync(jobId: string, status?: string): Promise<number> {
        if (!this._registrations.has(jobId)) throw new JobError('Job not found', 'JOB_NOT_FOUND', 404);
        if (!this._storage.deleteExecution) {
            throw new JobError('The job storage cannot delete runs', 'NOT_SUPPORTED', 501);
        }
        return deleteFinishedJobExecutions(
            (offset, limit) =>
                this._storage.getExecutions(jobId, { offset, limit, status: status as JobExecutionStatus | undefined }),
            (executionId) => this.deleteExecutionAsync(jobId, executionId),
        );
    }

    /** Update mutable job options (schedule, retry policy, etc.) and restart timers if active. */
    async updateOptionsAsync(id: string, updates: CliJobOptionsUpdate): Promise<void> {
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
        if (updates.retryDelay !== undefined) reg.options.retryDelay = updates.retryDelay;
        if (updates.retryStrategy !== undefined) reg.options.retryStrategy = updates.retryStrategy;
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
            maxRetries: reg.options.maxRetries ?? 1,
            retryDelay: reg.options.retryDelay ?? '5s',
            retryStrategy: reg.options.retryStrategy ?? 'exponential',
            timeout: reg.options.timeout,
            overlapPolicy: reg.options.overlapPolicy ?? 'skip',
            currentExecutionId: reg.currentExecutionId,
            nextRunAt: reg.nextRunAt,
            lastRunAt: reg.lastRunAt,
            lastRunStatus: reg.lastRunStatus,
            lastRunDuration: reg.lastRunDuration,
        };
    }

    private _startTimer(reg: JobRegistration, runNow = false): void {
        if (reg.options.schedule) {
            this._startCronTimer(reg);
        } else if (reg.options.interval) {
            this._startIntervalTimer(reg, runNow);
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

    private _startIntervalTimer(reg: JobRegistration, runNow = false): void {
        const ms = parseInterval(reg.options.interval!);
        if (ms === null) return;

        // Keep the rhythm across restarts and pauses: due one interval after the last run
        const now = Date.now();
        const lastRun = reg.lastRunAt ? new Date(reg.lastRunAt).getTime() : NaN;
        let due = Number.isNaN(lastRun) ? now + ms : lastRun + ms;
        if (due < now || runNow) due = now;
        reg.nextRunAt = new Date(due).toISOString();

        const fire = async () => {
            if (reg.status !== 'active' || !this._running) return;
            reg.nextRunAt = new Date(Date.now() + ms).toISOString();
            await this._handleTimerFire(reg);
        };
        reg.timer = setTimeout(() => {
            if (reg.status !== 'active' || !this._running) return;
            // Then every interval from this run on
            reg.timer = setInterval(fire, ms);
            reg.timerType = 'interval';
            fire().catch(() => undefined);
        }, due - now);
        reg.timerType = 'cron'; // a one-off timeout until the first run
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
            properties: {},
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
        execution.properties = { ...context.properties };

        await this._saveFinished(execution, context.discarded);

        reg.currentExecutionId = undefined;
        reg.currentAbortController = undefined;
        reg.lastRunAt = execution.startedAt;
        reg.lastRunStatus = finalStatus;
        reg.lastRunDuration = duration;

        // Persist state; a store failure must not leave the job looking busy or stop its retries
        await this._persistState(reg).catch((err) => console.error(`Saving the state of job ${reg.id} failed:`, err));

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
        if (finalStatus === 'failed' && retryAttempt < (reg.options.maxRetries ?? 1)) {
            const baseDelay = parseInterval(reg.options.retryDelay ?? '5s') ?? 5000;
            const strategy = reg.options.retryStrategy ?? 'exponential';
            const delay = strategy === 'fixed' ? baseDelay
                : strategy === 'linear' ? baseDelay * (retryAttempt + 1)
                : baseDelay * Math.pow(2, retryAttempt);
            this._broadcast({
                type: 'job:retrying',
                jobId: reg.id,
                executionId,
                attempt: retryAttempt + 1,
                maxRetries: reg.options.maxRetries ?? 1,
                delayMs: delay,
            });
            await new Promise(resolve => setTimeout(resolve, delay));
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

    /**
     * Saves the finished run, or deletes a discarded one (failed runs are always kept). When the store refuses the
     * run's properties (a value that does not serialize), the run is saved without them, so it never stays "running".
     */
    private async _saveFinished(execution: JobExecution, discard: boolean): Promise<void> {
        try {
            const discarded =
                discard && execution.status === 'completed' && (await deleteJobExecution(this._storage, execution.id));
            if (!discarded) await this._storage.saveExecution(execution);
        } catch (err) {
            if (!execution.properties || Object.keys(execution.properties).length === 0) throw err;
            console.error(`Saving execution ${execution.id} of job ${execution.jobId} failed; saving it without its properties:`, err);
            execution.properties = {};
            execution.logs = [
                ...(execution.logs ?? []),
                {
                    timestamp: new Date().toISOString(),
                    level: 'error',
                    message: `The run's properties could not be saved: ${err instanceof Error ? err.message : String(err)}`,
                },
            ];
            await this._storage.saveExecution(execution);
        }
    }

    private async _persistState(reg: JobRegistration): Promise<void> {
        await this._storage.saveJobState(reg.id, {
            status: reg.status,
            lastRunAt: reg.lastRunAt,
            updatedAt: new Date().toISOString(),
        });
    }

    /** Publishes a lifecycle event without waiting for in-process handlers (the bus never rejects). */
    private _broadcast(message: { type: string } & Record<string, unknown>): void {
        const { type, ...data } = message;
        void this.publishEvent(type, data);
    }
}

/** Typed error thrown by the scheduler, carrying an error code and HTTP status. */
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
