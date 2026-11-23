import type { Router } from 'express';
import type { CliDashboardExtension, CliInstalledPlugin, ICliAuditStore, ICliEventBus, ICliModule } from '@qodalis/cli-server-abstractions';
import { CliMigrationRunner, type CliMigrationDatabaseOptions, type CliMigrationRun } from './runner';
import { codeSource, sqlFolderSource, type CliMigration, type CliMigrationSource } from './sources';
import { CliMigrations } from './migrations';
import { createMigrationsController, MigrationsPermissions } from './controller';
import { CliMigrationsCommandProcessor } from './commands';
import { migrationsInstalledPlugin } from './package-info';
import { MigrationsMcpToolProvider } from './mcp';
import { MIGRATIONS_DASHBOARD_PREFIX, findMigrationsPage, migrationsPage } from './dashboard-page';

export const MIGRATIONS_PREFIX = '/api/v1/qcli/migrations';

/** The permissions the plugin adds to the server's catalog. */
export const MIGRATIONS_PERMISSION_ENTRIES = [
    { name: MigrationsPermissions.Read, description: 'See database migrations and their runs', group: 'Migrations' },
    { name: MigrationsPermissions.Run, description: 'Apply and roll back database migrations', group: 'Migrations' },
];

export interface CliMigrationsPluginResult {
    prefix: typeof MIGRATIONS_PREFIX;
    router: Router;
    /** `migrations:read` for GET, `migrations:run` for up and down (enforced on a protected server). */
    routePermissions: Array<{ path: string; read: string; write: string }>;
    /** The `migrations` terminal commands, registered by `mountPlugin`. */
    module: ICliModule;
    /** `migrations:read` and `migrations:run`, added to the server's permission catalog by `mountPlugin`. */
    permissions: Array<{ name: string; description: string; group: string }>;
    installedPlugin: CliInstalledPlugin;
    /** The migrations page of the admin dashboard (`/qcli/migrations`), when its build is there. */
    dashboardPrefix?: string;
    dashboardRouter?: Router;
    dashboardExtensions: CliDashboardExtension[];
    /** The `migrations_*` MCP tools, served when the server's MCP endpoint is on. */
    mcpProviders: MigrationsMcpToolProvider[];
    /** The registered databases: run, status and history from code. */
    migrations: CliMigrations;
    setEventBus(eventBus: ICliEventBus): void;
    /**
     * Applies the pending migrations of the databases marked `applyOnStartup`, one after another, waiting for
     * another process's run; rejects with the first failure. Await it before the server listens.
     */
    applyOnStartup(): Promise<CliMigrationRun[]>;
}

/**
 * The migrations plugin: versioned schema changes of relational databases (PostgreSQL, MySQL, SQL Server,
 * SQLite), applied under a lock, recorded in `QcliMigrations` / `QcliMigrationRuns`, and shown, run and rolled
 * back from the dashboard, the terminal (`migrations`) and the API at `/api/v1/qcli/migrations`.
 *
 * @example
 * ```ts
 * const migrations = new CliMigrationsBuilder()
 *     .addDatabase('main', { connection: postgresConnection(pool), applyOnStartup: true })
 *     .addSqlFolder('main', './migrations')
 *     .build();
 * await migrations.applyOnStartup();
 * mountPlugin(migrations);
 * ```
 */
export class CliMigrationsBuilder {
    private readonly databases: Array<{ name: string; options: CliMigrationDatabaseOptions; sources: CliMigrationSource[] }> = [];
    private auditStore?: ICliAuditStore;
    private dashboardDir?: string | false;

    /** Registers a database (its name is used in the API, the terminal and the dashboard). */
    addDatabase(name: string, options: CliMigrationDatabaseOptions): this {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`invalid database name: ${name}`);
        if (this.databases.some((d) => d.name === name)) throw new Error(`migration database already added: ${name}`);
        this.databases.push({ name, options, sources: [] });
        return this;
    }

    /** Adds a source of migrations to a database; sources apply in the order they were added. */
    addSource(database: string, source: CliMigrationSource): this {
        const db = this.databases.find((d) => d.name === database);
        if (!db) throw new Error(`unknown migration database: ${database}`);
        db.sources.push(source);
        return this;
    }

    /** Migrations from `NNNN_name.up.sql` / `.down.sql` files in `directory` (source `app` unless named). */
    addSqlFolder(database: string, directory: string, sourceName = 'app'): this {
        return this.addSource(database, sqlFolderSource(directory, sourceName));
    }

    /** Migrations given in code, as source `sourceName` (how plugins ship their schema). */
    addMigrations(database: string, sourceName: string, migrations: readonly CliMigration[]): this {
        return this.addSource(database, codeSource(sourceName, migrations));
    }

    /** Writes every run to the audit log (`migrations.up` / `migrations.down`), e.g. the users plugin's store. */
    setAuditStore(store: ICliAuditStore): this {
        this.auditStore = store;
        return this;
    }

    /**
     * Where the dashboard's migrations page is (`@qodalis/cli-dashboard-module-migrations`'s build); by default the
     * copy next to the plugin, else the installed package. `false` leaves the page out.
     */
    setDashboardDir(dir: string | false): this {
        this.dashboardDir = dir;
        return this;
    }

    build(): CliMigrationsPluginResult {
        const migrations = new CliMigrations();
        for (const db of this.databases) {
            const runner = new CliMigrationRunner(db.name, db.options);
            for (const source of db.sources) runner.addSource(source);
            migrations.add(runner);
        }
        migrations.setAuditStore(this.auditStore);
        const processor = new CliMigrationsCommandProcessor(migrations);
        const pageDir = this.dashboardDir === false ? undefined : findMigrationsPage(this.dashboardDir);
        const page = pageDir ? migrationsPage(pageDir) : undefined;
        return {
            prefix: MIGRATIONS_PREFIX,
            router: createMigrationsController(migrations),
            routePermissions: [{ path: MIGRATIONS_PREFIX, read: MigrationsPermissions.Read, write: MigrationsPermissions.Run }],
            module: {
                name: 'migrations',
                version: migrationsInstalledPlugin.version ?? '1.0.0',
                description: 'Database migrations: status, apply, roll back',
                author: { name: 'Qodalis', email: 'nicolae.lupei@qodalis.com' },
                icon: '🗄️',
                processors: [processor],
            },
            permissions: MIGRATIONS_PERMISSION_ENTRIES,
            installedPlugin: migrationsInstalledPlugin,
            ...(page ? { dashboardPrefix: MIGRATIONS_DASHBOARD_PREFIX, dashboardRouter: page.router } : {}),
            dashboardExtensions: page ? [page.extension] : [],
            mcpProviders: [new MigrationsMcpToolProvider(migrations)],
            migrations,
            setEventBus: (bus) => migrations.setEventBus(bus),
            applyOnStartup: async () => {
                const runs: CliMigrationRun[] = [];
                for (const db of this.databases.filter((d) => d.options.applyOnStartup)) {
                    const run = await migrations.run(db.name, 'up', { trigger: 'startup', wait: true });
                    runs.push(run);
                    if (run.status === 'failed') throw new Error(`migrations of ${db.name} failed: ${run.error}`);
                }
                return runs;
            },
        };
    }
}
