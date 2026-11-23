import { CliMigrationError, type CliMigrationRunOptions } from './runner';
import type { CliMigrations } from './migrations';
import { MigrationsPermissions } from './controller';

// The server's MCP tool shapes, repeated here so the plugin does not depend on @qodalis/cli-server-node
// (mountPlugin registers `mcpProviders` with the server's MCP endpoint).
type PropertySchema = { type: 'string' | 'integer' | 'boolean'; description?: string; default?: unknown };
type ToolResult = { text: string; structured?: Record<string, unknown>; isError: boolean };

/** An MCP tool of the migrations plugin (structurally the server's `McpTool`). */
export interface MigrationsMcpTool {
    name: string;
    description: string;
    inputSchema: { type: 'object'; properties: Record<string, PropertySchema>; required: string[]; additionalProperties: false };
    requiredPermissions: string[];
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    call(args: Record<string, unknown>, context: { auth?: { userName?: string } }): Promise<ToolResult>;
}

const schema = (properties: Record<string, PropertySchema>, required: string[] = []): MigrationsMcpTool['inputSchema'] => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
});
const json = (value: Record<string, unknown>, text?: string): ToolResult => ({ text: text ?? JSON.stringify(value, null, 2), structured: value, isError: false });
const error = (message: string): ToolResult => ({ text: message, isError: true });

const dbProp = { database: { type: 'string' as const, description: 'Database name (see migrations_status without one)' } };
const toUp = { type: 'string' as const, description: 'Stop after this migration (id or source:id); omit for all pending' };
const toDown = { type: 'string' as const, description: 'Roll back to this migration, keeping it (id or source:id), or base for everything' };

/**
 * Migrations tools: `migrations_status`, `migrations_runs`, `migrations_sql` (`migrations:read`),
 * `migrations_up` and `migrations_down` (`migrations:run`).
 */
export class MigrationsMcpToolProvider {
    readonly name = 'migrations';

    constructor(private readonly migrations: CliMigrations) {}

    getTools(): MigrationsMcpTool[] {
        const m = this.migrations;
        const guarded =
            (fn: (args: Record<string, unknown>, actor?: string) => Promise<ToolResult>) =>
            async (args: Record<string, unknown>, context: { auth?: { userName?: string } }) => {
                try {
                    return await fn(args, context.auth?.userName);
                } catch (err) {
                    return error(err instanceof Error ? err.message : String(err));
                }
            };
        const runner = (args: Record<string, unknown>) => {
            const db = m.database(String(args.database ?? ''));
            if (!db) throw new CliMigrationError(`unknown database: ${String(args.database ?? '')}`, 404);
            return db;
        };
        const optional = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
        const run = (direction: 'up' | 'down') =>
            guarded(async (args, actor) => {
                const options: CliMigrationRunOptions = { to: optional(args.to), force: args.force === true, actor, trigger: 'mcp' };
                if (direction === 'down' && !options.to) return error('to is required to roll back (an id, or base for everything)');
                const result = await m.run(runner(args).name, direction, options);
                const verb = direction === 'up' ? 'Applied' : 'Rolled back';
                const text = `${verb} ${result.applied.length} migration(s) (${result.status})${result.error ? `: ${result.error}` : ''}`;
                return { ...json({ ...result }, text), isError: result.status === 'failed' };
            });

        return [
            {
                name: 'migrations_status',
                description: 'Without a database: every database with its applied, pending and problem counts. With one: its migrations and their status (applied, pending, changed, missing, failed)',
                inputSchema: schema(dbProp),
                requiredPermissions: [MigrationsPermissions.Read],
                annotations: { readOnlyHint: true },
                call: guarded(async (args) => {
                    if (!optional(args.database)) {
                        const databases = await m.overview();
                        const text = databases
                            .map((d) => `${d.name} (${d.dialect}): ${d.error ? `error: ${d.error}` : `${d.applied} applied, ${d.pending} pending${d.problems ? `, ${d.problems} problem(s)` : ''}`}`)
                            .join('\n');
                        return json({ databases }, text || 'No databases');
                    }
                    const db = runner(args);
                    const migrations = await db.status();
                    const text = migrations.map((s) => `${s.status.padEnd(8)} ${s.source}:${s.id} ${s.name}`).join('\n');
                    return json({ name: db.name, dialect: db.dialect, sources: db.sourceNames, migrations }, text || 'No migrations');
                }),
            },
            {
                name: 'migrations_runs',
                description: 'Run history of a database, newest first: direction, trigger, who, status, error and what each run applied',
                inputSchema: schema({ ...dbProp, limit: { type: 'integer', description: 'Maximum runs (1-100)', default: 20 } }, ['database']),
                requiredPermissions: [MigrationsPermissions.Read],
                annotations: { readOnlyHint: true },
                call: guarded(async (args) => {
                    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
                    return json(await runner(args).runs(limit, 0));
                }),
            },
            {
                name: 'migrations_sql',
                description: 'The SQL a run would execute, without running it (dry run)',
                inputSchema: schema(
                    { ...dbProp, direction: { type: 'string', description: 'up (default) or down' }, to: { type: 'string', description: 'As for migrations_up / migrations_down' } },
                    ['database'],
                ),
                requiredPermissions: [MigrationsPermissions.Read],
                annotations: { readOnlyHint: true },
                call: guarded(async (args) => {
                    const db = runner(args);
                    const to = optional(args.to);
                    if (args.direction === 'down') {
                        if (!to) return error('to is required to roll back (an id, or base for everything)');
                        const { sql } = (await db.down({ to, dryRun: true })) as { sql: string };
                        return json({ sql }, sql || 'Nothing to roll back');
                    }
                    const { sql } = (await db.up({ to, dryRun: true })) as { sql: string };
                    return json({ sql }, sql || 'Nothing pending');
                }),
            },
            {
                name: 'migrations_up',
                description: 'Apply the pending migrations of a database (all, or up to one), under its lock; refused while a migration is changed or missing unless force',
                inputSchema: schema({ ...dbProp, to: toUp, force: { type: 'boolean', description: 'Run although a migration is changed or missing' } }, ['database']),
                requiredPermissions: [MigrationsPermissions.Run],
                call: run('up'),
            },
            {
                name: 'migrations_down',
                description: 'Roll back the migrations of a database applied after a migration (to), running their down scripts',
                inputSchema: schema({ ...dbProp, to: toDown, force: { type: 'boolean', description: 'Run although a migration is changed or missing' } }, ['database', 'to']),
                requiredPermissions: [MigrationsPermissions.Run],
                annotations: { destructiveHint: true },
                call: run('down'),
            },
        ];
    }
}
