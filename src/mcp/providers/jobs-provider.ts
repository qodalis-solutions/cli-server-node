import { CliJobScheduler, jobHasTags } from '@qodalis/cli-server-plugin-jobs';
import { CliEventPermissions, ICliEventBus } from '@qodalis/cli-server-abstractions';
import { CliServerPermissions as P } from '../../auth/cli-server-auth';
import { McpTool, McpToolAnnotations, McpToolCallContext, McpToolProvider, mcpError, mcpJson, mcpObjectSchema } from '../mcp-types';

const errorMessage = (err: unknown) => (err as Error)?.message ?? String(err);

/**
 * Resolves a job by id, or by a unique name (exact, then case-insensitive).
 * Returns the id, or an error message (not found / ambiguous name).
 */
export function resolveJobId(scheduler: CliJobScheduler, idOrName: string): { id: string } | { error: string } {
    if (scheduler.get(idOrName)) return { id: idOrName };
    const jobs = scheduler.getAll();
    let matches = jobs.filter((j) => j.name === idOrName);
    if (matches.length === 0) {
        const lower = idOrName.toLowerCase();
        matches = jobs.filter((j) => j.name.toLowerCase() === lower);
    }
    if (matches.length === 1) return { id: matches[0].id };
    if (matches.length > 1) return { error: `Job name '${idOrName}' is ambiguous (${matches.length} jobs); use the job id` };
    return { error: 'Job not found' };
}

/**
 * Jobs tools over the jobs plugin's scheduler: `jobs_list`, `jobs_get`,
 * `jobs_history` (`jobs:read`), `jobs_trigger|pause|resume|stop|cancel` and
 * `jobs_delete_runs` (`jobs:manage`). With an event bus, `jobs_trigger` publishes
 * `job:triggered` and `jobs_delete_runs` publishes `job:runs-deleted` (audience `jobs:read`).
 */
export class JobsMcpToolProvider implements McpToolProvider {
    readonly name = 'jobs';

    constructor(
        private readonly scheduler: CliJobScheduler,
        private readonly eventBus?: ICliEventBus,
    ) {}

    private publish(type: string, data: Record<string, unknown>, context: McpToolCallContext): Promise<void> {
        const actor = context.auth?.userName;
        return this.eventBus?.publish(type, { ...data, ...(actor ? { actor } : {}) }, { permission: CliEventPermissions.JobsRead }) ?? Promise.resolve();
    }

    getTools(): McpTool[] {
        const s = this.scheduler;
        const idProp = { id: { type: 'string' as const, description: 'Job id or unique job name' } };
        const resolve = (idOrName: unknown) => resolveJobId(s, idOrName as string);
        const action = (
            name: string,
            description: string,
            fn: (id: string) => Promise<void>,
            annotations?: McpToolAnnotations,
            event?: string,
        ): McpTool => ({
            name,
            description,
            inputSchema: mcpObjectSchema(idProp, ['id']),
            requiredPermissions: [P.JobsManage],
            ...(annotations ? { annotations } : {}),
            call: async (args, context) => {
                const job = resolve(args.id);
                if ('error' in job) return mcpError(job.error);
                try {
                    await fn(job.id);
                    if (event) await this.publish(event, { jobId: job.id }, context);
                    return mcpJson({ ok: true, id: job.id }, `${name.slice('jobs_'.length)}: ok`);
                } catch (err) {
                    return mcpError(errorMessage(err));
                }
            },
        });
        return [
            {
                name: 'jobs_list',
                description: 'List the scheduled jobs, optionally only those with every given tag',
                inputSchema: mcpObjectSchema({
                    tags: { type: 'array', items: { type: 'string' }, description: 'Only jobs that have every one of these tags (ignoring case)' },
                }),
                requiredPermissions: [P.JobsRead],
                annotations: { readOnlyHint: true },
                call: async (args) => {
                    const tags = ((args.tags as string[] | undefined) ?? []).map((t) => t.trim()).filter(Boolean);
                    const jobs = s.getAll().filter((j) => jobHasTags(j, tags));
                    const text = jobs
                        .map((j) => `${j.id} | ${j.name} | ${j.status}${j.schedule ? ` | ${j.schedule}` : j.interval ? ` | every ${j.interval}` : ''}${j.tags.length ? ` | tags: ${j.tags.join(', ')}` : ''}`)
                        .join('\n');
                    return mcpJson({ jobs }, text || 'No jobs');
                },
            },
            {
                name: 'jobs_get',
                description: 'Details of a job',
                inputSchema: mcpObjectSchema(idProp, ['id']),
                requiredPermissions: [P.JobsRead],
                annotations: { readOnlyHint: true },
                call: async (args) => {
                    const job = resolve(args.id);
                    if ('error' in job) return mcpError(job.error);
                    return mcpJson({ ...s.get(job.id)! });
                },
            },
            {
                name: 'jobs_history',
                description: 'Recent executions of a job (newest first)',
                inputSchema: mcpObjectSchema(
                    { ...idProp, limit: { type: 'integer', description: 'Maximum executions (1-100)', default: 20 } },
                    ['id'],
                ),
                requiredPermissions: [P.JobsRead],
                annotations: { readOnlyHint: true },
                call: async (args) => {
                    const job = resolve(args.id);
                    if ('error' in job) return mcpError(job.error);
                    const id = job.id;
                    const limit = Math.min(Math.max((args.limit as number | undefined) ?? 20, 1), 100);
                    try {
                        const result = await s.storage.getExecutions(id, { limit, offset: 0 });
                        const items = result.items.map((exec) => {
                            const { logs, ...rest } = exec;
                            return { ...rest, properties: exec.properties ?? {}, logCount: logs?.length ?? 0 };
                        });
                        return mcpJson({ items, total: result.total, limit });
                    } catch (err) {
                        return mcpError(errorMessage(err));
                    }
                },
            },
            {
                name: 'jobs_trigger',
                description: 'Run a job now (queued when every run slot is taken and its overlap policy is queue or cancel)',
                inputSchema: mcpObjectSchema(idProp, ['id']),
                requiredPermissions: [P.JobsManage],
                call: async (args, context) => {
                    const job = resolve(args.id);
                    if ('error' in job) return mcpError(job.error);
                    try {
                        const result = await s.triggerAsync(job.id);
                        await this.publish('job:triggered', { jobId: job.id }, context);
                        const queued = !!result?.queued;
                        return mcpJson({ ok: true, id: job.id, queued }, queued ? 'Job queued' : 'Job triggered');
                    } catch (err) {
                        return mcpError(errorMessage(err));
                    }
                },
            },
            action('jobs_pause', 'Pause a job schedule', (id) => s.pauseAsync(id)),
            action('jobs_resume', 'Resume a paused job', (id) => s.resumeAsync(id)),
            action('jobs_stop', 'Stop a job (and cancel its current run)', (id) => s.stopJobAsync(id), { destructiveHint: true }),
            action('jobs_cancel', 'Cancel the current run of a job', (id) => s.cancelCurrentAsync(id), { destructiveHint: true }),
            {
                name: 'jobs_delete_runs',
                description:
                    'Delete runs of a job and their logs: one run (executionId), else every finished run, or only those with a status (e.g. failed). Running runs are never deleted.',
                inputSchema: mcpObjectSchema(
                    {
                        ...idProp,
                        executionId: { type: 'string', description: 'The run to delete; omit to delete many' },
                        status: { type: 'string', description: 'Only runs with this status (completed, failed, cancelled, timed_out)' },
                    },
                    ['id'],
                ),
                requiredPermissions: [P.JobsManage],
                annotations: { destructiveHint: true },
                call: async (args, context) => {
                    const job = resolve(args.id);
                    if ('error' in job) return mcpError(job.error);
                    try {
                        if (typeof args.executionId === 'string' && args.executionId) {
                            await s.deleteExecutionAsync(job.id, args.executionId);
                            await this.publish('job:runs-deleted', { jobId: job.id, executionId: args.executionId }, context);
                            return mcpJson({ deleted: 1, id: job.id }, 'Run deleted');
                        }
                        const status = typeof args.status === 'string' && args.status ? args.status : undefined;
                        const deleted = await s.deleteExecutionsAsync(job.id, status);
                        await this.publish('job:runs-deleted', { jobId: job.id, count: deleted }, context);
                        return mcpJson({ deleted, id: job.id }, `Deleted ${deleted} run(s)`);
                    } catch (err) {
                        return mcpError(errorMessage(err));
                    }
                },
            },
        ];
    }
}
