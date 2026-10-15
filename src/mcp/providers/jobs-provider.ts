import { CliJobScheduler } from '@qodalis/cli-server-plugin-jobs';
import { CliServerPermissions as P } from '../../auth/cli-server-auth';
import { McpTool, McpToolAnnotations, McpToolProvider, mcpError, mcpJson, mcpObjectSchema } from '../mcp-types';

const errorMessage = (err: unknown) => (err as Error)?.message ?? String(err);

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
        const idProp = { id: { type: 'string' as const, description: 'Job id' } };
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
                try {
                    await fn(args.id as string);
                    return mcpJson({ ok: true, id: args.id }, `${name.slice('jobs_'.length)}: ok`);
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
                    const job = s.get(args.id as string);
                    return job ? mcpJson({ ...job }) : mcpError('Job not found');
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
                    const id = args.id as string;
                    if (!s.getRegistration(id)) return mcpError('Job not found');
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
