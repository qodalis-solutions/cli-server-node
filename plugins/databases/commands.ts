import {
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliProcessCommand,
    getPositionalText,
    ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import { CliMigrationError, type CliMigrationRun } from './runner';
import type { CliDatabases } from './databases';
import { DatabasesPermissions } from './controller';

const toParam = new CliCommandParameterDescriptor('to', 'Migration to stop at (id or source:id; down: base for everything)', false, 'string');
const dryRunParam = new CliCommandParameterDescriptor('dry-run', 'Show the SQL instead of running it', false, 'boolean');
const forceParam = new CliCommandParameterDescriptor('force', 'Run although migrations changed or went missing', false, 'boolean');

function databaseOf(databases: CliDatabases, command: CliProcessCommand): string {
    const name = getPositionalText(command) || (databases.databases.length === 1 ? databases.databases[0].name : '');
    if (!name) throw new CliMigrationError(`name the database: ${databases.databases.map((d) => d.name).join(', ')}`, 400);
    return name;
}

/** 1536 -> `1.5 KB`. */
export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function describeRun(run: CliMigrationRun): string {
    const lines = [`${run.direction === 'up' ? 'Applied' : 'Rolled back'} ${run.applied.length} migration(s) (${run.status})`];
    for (const a of run.applied) lines.push(`  ${a.source}:${a.id}  ${a.name}  ${a.durationMs} ms`);
    if (run.error) lines.push(`Failed: ${run.error}`);
    return lines.join('\n');
}

const errorText = (err: unknown) => `Error: ${err instanceof Error ? err.message : String(err)}`;

class DatabasesListProcessor extends CliCommandProcessor {
    command = 'list';
    description = 'Lists the databases: size, applied and pending migrations';
    requiredPermissions = [DatabasesPermissions.Read];

    constructor(private readonly databases: CliDatabases) {
        super();
    }

    async handleAsync(): Promise<string> {
        const databases = await this.databases.overview();
        if (databases.length === 0) return 'No databases registered.';
        return databases
            .map((d) =>
                d.error
                    ? `${d.name} (${d.dialect}): ${d.error}`
                    : `${d.name} (${d.dialect})${d.sizeBytes !== undefined ? ` ${formatBytes(d.sizeBytes)}` : ''}: ${d.applied} applied, ${d.pending} pending${d.problems ? `, ${d.problems} to look at` : ''}`,
            )
            .join('\n');
    }
}

class DatabasesStatsProcessor extends CliCommandProcessor {
    command = 'stats';
    description = 'Shows the size, connections, load counters and largest tables of a database';
    acceptsValue = true;
    requiredPermissions = [DatabasesPermissions.Read];
    examples = [{ command: 'databases stats main', description: 'Stats of the database main' }];

    constructor(private readonly databases: CliDatabases) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        try {
            const s = await this.databases.stats(databaseOf(this.databases, command));
            const lines = [`${s.name} (${s.dialect})${s.server?.version ? `  ${s.server.version}` : ''}`];
            if (s.server?.uptimeSeconds !== undefined) lines.push(`  Uptime        ${Math.floor(s.server.uptimeSeconds / 3600)} h ${Math.floor((s.server.uptimeSeconds % 3600) / 60)} min`);
            if (s.size?.bytes !== undefined) {
                const parts = [
                    s.size.dataBytes !== undefined ? `data ${formatBytes(s.size.dataBytes)}` : '',
                    s.size.indexBytes !== undefined ? `indexes ${formatBytes(s.size.indexBytes)}` : '',
                    s.size.logBytes !== undefined ? `log ${formatBytes(s.size.logBytes)}` : '',
                ].filter(Boolean);
                lines.push(`  Size          ${formatBytes(s.size.bytes)}${parts.length ? ` (${parts.join(', ')})` : ''}`);
            }
            if (s.connections) {
                const c = s.connections;
                lines.push(`  Connections   ${c.active ?? '?'} active, ${c.open ?? '?'} open${c.max !== undefined ? ` of ${c.max}` : ''}`);
            }
            if (s.counters) {
                const counters = Object.entries(s.counters).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`);
                if (counters.length) lines.push(`  Counters      ${counters.join(', ')}${s.countersScope === 'server' ? ' (server)' : ''}`);
            }
            if (s.cacheHitRatio !== undefined) lines.push(`  Cache hits    ${(s.cacheHitRatio * 100).toFixed(1)}%`);
            if (s.tables?.length) {
                lines.push('  Largest tables');
                for (const t of s.tables) {
                    lines.push(`    ${(t.schema ? `${t.schema}.${t.name}` : t.name).padEnd(32)} ${t.bytes !== undefined ? formatBytes(t.bytes).padStart(9) : ''}  ${t.rows ?? ''} rows`);
                }
            }
            for (const u of s.unavailable) lines.push(`  (${u.metric} unavailable: ${u.error})`);
            return lines.join('\n');
        } catch (err) {
            return errorText(err);
        }
    }
}

class MigrationsStatusProcessor extends CliCommandProcessor {
    command = 'migrations';
    description = 'Shows the migrations of a database and their status';
    acceptsValue = true;
    requiredPermissions = [DatabasesPermissions.Read];
    examples = [{ command: 'databases migrations main', description: 'Migrations of the database main' }];

    constructor(private readonly databases: CliDatabases) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        try {
            const db = this.databases.database(databaseOf(this.databases, command));
            if (!db) return 'Error: unknown database';
            const states = await db.status();
            if (states.length === 0) return `${db.name}: no migrations`;
            return [`${db.name} (${db.dialect})`, ...states.map((s) => `  ${s.status.padEnd(8)} ${s.source}:${s.id}  ${s.name}${s.appliedAt ? `  ${s.appliedAt}` : ''}`)].join('\n');
        } catch (err) {
            return errorText(err);
        }
    }
}

class MigrationsRunProcessor extends CliCommandProcessor {
    acceptsValue = true;
    requiredPermissions = [DatabasesPermissions.Migrate];
    parameters = [toParam, dryRunParam, forceParam];

    constructor(
        private readonly databases: CliDatabases,
        readonly direction: 'up' | 'down',
    ) {
        super();
        this.command = direction;
        this.description = direction === 'up' ? 'Applies the pending migrations of a database' : 'Rolls back migrations of a database to --to';
        this.examples =
            direction === 'up'
                ? [
                      { command: 'databases up main', description: 'Apply every pending migration' },
                      { command: 'databases up main --dry-run', description: 'Show the SQL first' },
                  ]
                : [{ command: 'databases down main --to 0003', description: 'Roll back what came after 0003' }];
    }

    command: string;
    description: string;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        try {
            const name = databaseOf(this.databases, command);
            const to = command.args?.to !== undefined ? String(command.args.to) : undefined;
            if (this.direction === 'down' && !to) return 'Error: --to is required to roll back (an id, or base for everything)';
            if (command.args?.['dry-run']) {
                const db = this.databases.database(name);
                if (!db) return `Error: unknown database: ${name}`;
                const result = (this.direction === 'up' ? await db.up({ to, dryRun: true }) : await db.down({ to: to!, dryRun: true })) as { sql: string };
                return result.sql || 'Nothing to run.';
            }
            const run = await this.databases.run(name, this.direction, { to, force: command.args?.force === true, trigger: 'terminal' });
            return describeRun(run);
        } catch (err) {
            return errorText(err);
        }
    }
}

/** `databases` (alias `db`): `list`, `stats <db>`, `migrations <db>`, `up <db>`, `down <db> --to <id>`. */
export class CliDatabasesCommandProcessor extends CliCommandProcessor {
    command = 'databases';
    aliases = ['db'];
    description = 'Databases: size, load, largest tables and migrations (status, apply, roll back)';
    module = 'databases';
    icon = '🗄️';
    requiredPermissions = [DatabasesPermissions.Read];
    processors: ICliCommandProcessor[];
    private readonly list: DatabasesListProcessor;

    constructor(databases: CliDatabases) {
        super();
        this.list = new DatabasesListProcessor(databases);
        this.processors = [
            this.list,
            new DatabasesStatsProcessor(databases),
            new MigrationsStatusProcessor(databases),
            new MigrationsRunProcessor(databases, 'up'),
            new MigrationsRunProcessor(databases, 'down'),
        ];
    }

    handleAsync(): Promise<string> {
        return this.list.handleAsync();
    }
}
