import {
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliProcessCommand,
    getPositionalText,
    ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import { CliMigrationError, type CliMigrationRun } from './runner';
import type { CliMigrations } from './migrations';
import { MigrationsPermissions } from './controller';

const toParam = new CliCommandParameterDescriptor('to', 'Migration to stop at (id or source:id; down: base for everything)', false, 'string');
const dryRunParam = new CliCommandParameterDescriptor('dry-run', 'Show the SQL instead of running it', false, 'boolean');
const forceParam = new CliCommandParameterDescriptor('force', 'Run although migrations changed or went missing', false, 'boolean');

function databaseOf(migrations: CliMigrations, command: CliProcessCommand): string {
    const name = getPositionalText(command) || (migrations.databases.length === 1 ? migrations.databases[0].name : '');
    if (!name) throw new CliMigrationError(`name the database: ${migrations.databases.map((d) => d.name).join(', ')}`, 400);
    return name;
}

function describeRun(run: CliMigrationRun): string {
    const lines = [`${run.direction === 'up' ? 'Applied' : 'Rolled back'} ${run.applied.length} migration(s) (${run.status})`];
    for (const a of run.applied) lines.push(`  ${a.source}:${a.id}  ${a.name}  ${a.durationMs} ms`);
    if (run.error) lines.push(`Failed: ${run.error}`);
    return lines.join('\n');
}

const errorText = (err: unknown) => `Error: ${err instanceof Error ? err.message : String(err)}`;

class MigrationsStatusProcessor extends CliCommandProcessor {
    command = 'status';
    description = 'Shows the migrations of a database and their status';
    acceptsValue = true;
    requiredPermissions = [MigrationsPermissions.Read];
    examples = [{ command: 'migrations status main', description: 'Migrations of the database main' }];

    constructor(private readonly migrations: CliMigrations) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        try {
            const db = this.migrations.database(databaseOf(this.migrations, command));
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
    requiredPermissions = [MigrationsPermissions.Run];
    parameters = [toParam, dryRunParam, forceParam];

    constructor(
        private readonly migrations: CliMigrations,
        readonly direction: 'up' | 'down',
    ) {
        super();
        this.command = direction;
        this.description = direction === 'up' ? 'Applies the pending migrations of a database' : 'Rolls back migrations of a database to --to';
        this.examples =
            direction === 'up'
                ? [
                      { command: 'migrations up main', description: 'Apply every pending migration' },
                      { command: 'migrations up main --dry-run', description: 'Show the SQL first' },
                  ]
                : [{ command: 'migrations down main --to 0003', description: 'Roll back what came after 0003' }];
    }

    command: string;
    description: string;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        try {
            const name = databaseOf(this.migrations, command);
            const to = command.args?.to !== undefined ? String(command.args.to) : undefined;
            if (this.direction === 'down' && !to) return 'Error: --to is required to roll back (an id, or base for everything)';
            if (command.args?.['dry-run']) {
                const db = this.migrations.database(name);
                if (!db) return `Error: unknown database: ${name}`;
                const result = (this.direction === 'up' ? await db.up({ to, dryRun: true }) : await db.down({ to: to!, dryRun: true })) as { sql: string };
                return result.sql || 'Nothing to run.';
            }
            const run = await this.migrations.run(name, this.direction, { to, force: command.args?.force === true, trigger: 'terminal' });
            return describeRun(run);
        } catch (err) {
            return errorText(err);
        }
    }
}

/** `migrations` (the databases), `migrations status|up|down <db>`. */
export class CliMigrationsCommandProcessor extends CliCommandProcessor {
    command = 'migrations';
    description = 'Database migrations: status, apply, roll back';
    module = 'migrations';
    icon = '🗄️';
    requiredPermissions = [MigrationsPermissions.Read];
    processors: ICliCommandProcessor[];

    constructor(private readonly migrations: CliMigrations) {
        super();
        this.processors = [new MigrationsStatusProcessor(migrations), new MigrationsRunProcessor(migrations, 'up'), new MigrationsRunProcessor(migrations, 'down')];
    }

    async handleAsync(): Promise<string> {
        const databases = await this.migrations.overview();
        if (databases.length === 0) return 'No databases registered.';
        return databases
            .map((d) =>
                d.error
                    ? `${d.name} (${d.dialect}): ${d.error}`
                    : `${d.name} (${d.dialect}): ${d.applied} applied, ${d.pending} pending${d.problems ? `, ${d.problems} to look at` : ''}`,
            )
            .join('\n');
    }
}
