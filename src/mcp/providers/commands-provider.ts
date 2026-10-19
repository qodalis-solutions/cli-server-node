import { CliProcessCommand, ICliCommandProcessor, quoteShellWord as quote } from '../../abstractions';
import { CliServerPermissions as P } from '../../auth/cli-server-auth';
import { ICliCommandRegistry } from '../../services/cli-command-registry';
import { ICliCommandExecutorService } from '../../services/cli-command-executor-service';
import { commandResult } from '../mcp-render';
import { McpInputSchema, McpPropertySchema, McpTool, McpToolProvider, mcpObjectSchema } from '../mcp-types';

/** Maximum MCP tool name length. */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

/** Tool name of a command path: joined with `_`, lower-cased, `[^a-z0-9_-]` → `-`, max 64 characters. */
export function mcpToolName(path: string[]): string {
    return path
        .join('_')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .slice(0, MCP_TOOL_NAME_MAX_LENGTH);
}

function propertyType(type: string | undefined): McpPropertySchema {
    switch ((type ?? '').toLowerCase()) {
        case 'number':
            return { type: 'number' };
        case 'boolean':
            return { type: 'boolean' };
        case 'array':
            return { type: 'array', items: { type: 'string' } };
        default:
            return { type: 'string' };
    }
}

/** True when the processor takes a positional value (`valueRequired` or `acceptsValue`). */
function takesValue(processor: ICliCommandProcessor): boolean {
    return !!processor.valueRequired || !!processor.acceptsValue;
}

/** Input schema of a processor: one property per parameter, plus `value` (positional input) when it takes a value. */
export function commandInputSchema(processor: ICliCommandProcessor): McpInputSchema {
    const properties: Record<string, McpPropertySchema> = {};
    const required: string[] = [];
    for (const param of processor.parameters ?? []) {
        if (!param?.name || Object.prototype.hasOwnProperty.call(properties, param.name)) continue;
        const prop = propertyType(param.type);
        if (param.description) prop.description = param.description;
        if (param.defaultValue !== undefined && param.defaultValue !== null) prop.default = param.defaultValue;
        properties[param.name] = prop;
        if (param.required) required.push(param.name);
    }
    if (takesValue(processor) && !Object.prototype.hasOwnProperty.call(properties, 'value')) {
        properties.value = { type: 'string', description: 'The positional input of the command' };
        if (processor.valueRequired) required.push('value');
    }
    return mcpObjectSchema(properties, required);
}

/**
 * The command the CLI would send (`value` becomes the positional input when the
 * command takes one). `rawCommand` is quoted so the browser's parser reads it
 * back; `positionals` comes straight from the tool arguments, not re-parsed.
 */
export function buildCliCommand(path: string[], positional: boolean, args: Record<string, unknown>): CliProcessCommand {
    const params: Record<string, any> = {};
    for (const [key, v] of Object.entries(args)) {
        if (v !== null && v !== undefined) params[key] = v;
    }
    let value: string | undefined;
    if (positional && typeof params.value === 'string') {
        value = params.value;
        delete params.value;
    }
    const parts = [...path];
    if (value !== undefined) parts.push(quote(value));
    for (const [key, v] of Object.entries(params)) {
        if (typeof v === 'boolean') {
            parts.push(v ? `--${key}` : `--${key}=false`);
        } else {
            parts.push(`--${key}=${quote(Array.isArray(v) ? v.join(',') : String(v))}`);
        }
    }
    return {
        command: path[0],
        chainCommands: path.slice(1),
        rawCommand: parts.join(' '),
        ...(value !== undefined ? { value } : {}),
        positionals: value !== undefined ? [value] : [],
        args: params,
    };
}

/**
 * One tool per command: every root processor and sub-processor that has no
 * sub-processors, declares parameters or takes a value. Calls run through the
 * same executor as `/execute`.
 */
export class CommandsMcpToolProvider implements McpToolProvider {
    readonly name = 'commands';

    constructor(
        private readonly registry: ICliCommandRegistry,
        private readonly executor: ICliCommandExecutorService,
    ) {}

    getTools(): McpTool[] {
        const tools: McpTool[] = [];
        const walk = (processor: ICliCommandProcessor, path: string[], permissions: string[]) => {
            const chainPermissions = [...permissions, ...(processor.requiredPermissions ?? [])];
            const children = processor.processors ?? [];
            if (children.length === 0 || (processor.parameters?.length ?? 0) > 0 || takesValue(processor)) {
                const name = mcpToolName(path);
                if (name) tools.push(this.toTool(processor, name, [...path], chainPermissions));
            }
            for (const child of children) {
                if (child?.command) walk(child, [...path, child.command], chainPermissions);
            }
        };
        for (const root of this.registry.processors) {
            if (root?.command) walk(root, [root.command], []);
        }
        return tools;
    }

    private toTool(processor: ICliCommandProcessor, name: string, path: string[], permissions: string[]): McpTool {
        const positional = takesValue(processor) && !(processor.parameters ?? []).some((p) => p?.name === 'value');
        return {
            name,
            description: processor.description || `Run '${path.join(' ')}'`,
            inputSchema: commandInputSchema(processor),
            requiredPermissions: [P.CommandsExecute, ...permissions],
            call: async (args, context) => {
                const response = await this.executor.executeAsync(buildCliCommand(path, positional, args), context.signal);
                return commandResult(response);
            },
        };
    }
}
