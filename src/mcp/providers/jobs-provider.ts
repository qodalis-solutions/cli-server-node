import { CliJobScheduler } from '@qodalis/cli-server-plugin-jobs';
import { CliServerPermissions as P } from '../../auth/cli-server-auth';
import { McpTool, McpToolAnnotations, McpToolProvider, mcpError, mcpJson, mcpObjectSchema } from '../mcp-types';

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
 * `jobs_history` (`jobs:read`) and `jobs_trigger|pause|resume|stop|cancel`
 * (`jobs:manage`).
 */
export class JobsMcpToolProvider implements McpToolProvider {
    readonly name = 'jobs';

    constructor(private readonly scheduler: CliJobScheduler) {}

    getTools(): McpTool[] {
        const s = this.scheduler;
        const idProp = { id: { type: 'string' as const, description: 'Job id or unique job name' } };
        const resolve = (idOrName: unknown) => resolveJobId(s, idOrName as string);
        const action = (
            name: string,
            description: string,
            fn: (id: string) => Promise<void>,
            annotations?: McpToolAnnotations,
        ): McpTool => ({
            name,
            description,
            inputSchema: mcpObjectSchema(idProp, ['id']),
            requiredPermissions: [P.JobsManage],
            ...(annotations ? { annotations } : {}),
            call: async (args) => {
                const job = resolve(args.id);
                if ('error' in job) return mcpError(job.error);
                try {
                    await fn(job.id);
                    return mcpJson({ ok: true, id: job.id }, `${name.slice('jobs_'.length)}: ok`);
                } catch (err) {
                    return mcpError(errorMessage(err));
                }
            },
        });
        return [
            {
                name: 'jobs_list',
                description: 'List the scheduled jobs',
                inputSchema: mcpObjectSchema(),
                requiredPermissions: [P.JobsRead],
                annotations: { readOnlyHint: true },
                call: async () => {
                    const jobs = s.getAll();
                    const text = jobs.map((j) => `${j.id} | ${j.name} | ${j.status}${j.schedule ? ` | ${j.schedule}` : j.interval ? ` | every ${j.interval}` : ''}`).join('\n');
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
                            return { ...rest, logCount: logs?.length ?? 0 };
                        });
                        return mcpJson({ items, total: result.total, limit });
                    } catch (err) {
                        return mcpError(errorMessage(err));
                    }
                },
            },
            action('jobs_trigger', 'Run a job now', (id) => s.triggerAsync(id)),
            action('jobs_pause', 'Pause a job schedule', (id) => s.pauseAsync(id)),
            action('jobs_resume', 'Resume a paused job', (id) => s.resumeAsync(id)),
            action('jobs_stop', 'Stop a job (and cancel its current run)', (id) => s.stopJobAsync(id), { destructiveHint: true }),
            action('jobs_cancel', 'Cancel the current run of a job', (id) => s.cancelCurrentAsync(id), { destructiveHint: true }),
        ];
    }
}
