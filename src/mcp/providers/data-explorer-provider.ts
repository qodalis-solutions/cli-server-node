import { DataExplorerExecutor, DataExplorerRegistry, filterSchema, missingPermissions } from '@qodalis/cli-server-plugin-data-explorer';
import { DataExplorerCaller } from '@qodalis/cli-server-abstractions';
import { CliServerPermissions as P } from '../../auth/cli-server-auth';
import { renderRows } from '../mcp-render';
import { McpTool, McpToolCallContext, McpToolProvider, mcpError, mcpJson, mcpObjectSchema } from '../mcp-types';

/**
 * Data explorer tools over the same registry and executor (timeouts, row
 * limits) as `/api/qcli/data-explorer`: `data_sources`, `data_schema`,
 * `data_query` (`data:query`).
 */
export class DataExplorerMcpToolProvider implements McpToolProvider {
    readonly name = 'data-explorer';

    constructor(
        private readonly registry: DataExplorerRegistry,
        private readonly executor: DataExplorerExecutor,
        /** Who makes a call (the source's permissions, rate limit and audit apply to it). */
        private readonly caller: (context: McpToolCallContext) => DataExplorerCaller | undefined = () => undefined,
    ) {}

    getTools(): McpTool[] {
        const sourceProp = { source: { type: 'string' as const, description: 'Data source name (see data_sources)' } };
        return [
            {
                name: 'data_sources',
                description: 'List the registered data sources',
                inputSchema: mcpObjectSchema(),
                requiredPermissions: [P.DataQuery],
                annotations: { readOnlyHint: true },
                call: async (_args, context) => {
                    const sources = this.registry.getSources(this.caller(context));
                    const text = sources.map((s) => `${s.name} (${s.language})${s.description ? ` - ${s.description}` : ''}`).join('\n');
                    return mcpJson({ sources }, text);
                },
            },
            {
                name: 'data_schema',
                description: 'Schema (tables/collections and columns) of a data source',
                inputSchema: mcpObjectSchema(sourceProp, ['source']),
                requiredPermissions: [P.DataQuery],
                annotations: { readOnlyHint: true },
                call: async (args, context) => {
                    const source = args.source as string;
                    const entry = this.registry.get(source);
                    if (!entry) return mcpError(`Unknown data source: '${source}'`);
                    const missing = missingPermissions(entry.options.requiredPermissions, this.caller(context));
                    if (missing.length) return mcpError(`forbidden: missing permission ${missing.join(', ')}`);
                    if (!entry.provider.getSchemaAsync) return mcpError('Schema introspection is not supported by this data source.');
                    try {
                        const schema = filterSchema(await entry.provider.getSchemaAsync(entry.options), entry.options);
                        return mcpJson({ ...(schema as unknown as Record<string, unknown>) });
                    } catch (err) {
                        return mcpError((err as Error)?.message ?? String(err));
                    }
                },
            },
            {
                name: 'data_query',
                description: 'Run a query against a data source',
                inputSchema: mcpObjectSchema(
                    {
                        ...sourceProp,
                        query: { type: 'string', description: 'Query in the source language' },
                        parameters: { type: 'object', description: 'Query parameters' },
                    },
                    ['source', 'query'],
                ),
                requiredPermissions: [P.DataQuery],
                call: async (args, context) => {
                    const result = await this.executor.executeAsync(
                        {
                            source: args.source as string,
                            query: args.query as string,
                            parameters: (args.parameters as Record<string, unknown> | undefined) ?? {},
                        },
                        this.caller(context),
                    );
                    if (!result.success) return mcpError(result.error ?? 'Query failed');
                    const table = renderRows(result.columns, result.rows as unknown[]);
                    const footer = `(${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${result.truncated ? ', truncated' : ''})`;
                    return mcpJson({ ...(result as unknown as Record<string, unknown>) }, table ? `${table}\n${footer}` : footer);
                },
            },
        ];
    }
}
