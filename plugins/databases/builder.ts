import type { Router } from 'express';
import type { CliDashboardExtension, CliInstalledPlugin, ICliAuditStore, ICliEventBus, ICliModule } from '@qodalis/cli-server-abstractions';
import { CliMigrationRunner, type CliMigrationDatabaseOptions, type CliMigrationRun } from './runner';
import { codeSource, sqlFolderSource, type CliMigration, type CliMigrationSource } from './sources';
import { CliDatabases } from './databases';
import { createDatabasesController, DatabasesPermissions } from './controller';
import { CliDatabasesCommandProcessor } from './commands';
import { databasesInstalledPlugin } from './package-info';
import { DatabasesMcpToolProvider } from './mcp';
import { DATABASES_DASHBOARD_PREFIX, findDatabasesPage, databasesPage } from './dashboard-page';

export const DATABASES_PREFIX = '/api/v1/qcli/databases';

/** The permissions the plugin adds to the server's catalog. */
export const DATABASES_PERMISSION_ENTRIES = [
    { name: DatabasesPermissions.Read, description: 'See databases, their stats and migrations', group: 'Databases' },
    { name: DatabasesPermissions.Migrate, description: 'Apply and roll back database migrations', group: 'Databases' },
];

export interface CliDatabasesPluginResult {
    prefix: typeof DATABASES_PREFIX;
    router: Router;
    /** `databases:read` for GET, `databases:migrate` for up and down (enforced on a protected server). */
    routePermissions: Array<{ path: string; read: string; write: string }>;
    /** The `databases` terminal commands, registered by `mountPlugin`. */
    module: ICliModule;
    /** `databases:read` and `databases:migrate`, added to the server's permission catalog by `mountPlugin`. */
    permissions: Array<{ name: string; description: string; group: string }>;
    installedPlugin: CliInstalledPlugin;
    /** The databases page of the admin dashboard (`/qcli/databases`), when its build is there. */
    dashboardPrefix?: string;
    dashboardRouter?: Router;
    dashboardExtensions: CliDashboardExtension[];
    /** The `databases_*` and `migrations_*` MCP tools, served when the server's MCP endpoint is on. */
    mcpProviders: DatabasesMcpToolProvider[];
    /** The registered databases: stats, migration runs, status and history from code. */
    databases: CliDatabases;
    setEventBus(eventBus: ICliEventBus): void;
    /**
     * Applies the pending migrations of the databases marked `applyOnStartup`, one after another, waiting for
     * another process's run; rejects with the first failure. Await it before the server listens.
     */
    applyOnStartup(): Promise<CliMigrationRun[]>;
}

/**
 * The databases plugin: the server's relational databases (PostgreSQL, MySQL, SQL Server, SQLite) with their size,
 * load and largest tables, and their migrations: versioned schema changes applied under a lock, recorded in
 * `QcliMigrations` / `QcliMigrationRuns`, and shown, run and rolled back from the dashboard, the terminal
 * (`databases`), MCP and the API at `/api/v1/qcli/databases`.
 *
 * @example
 * ```ts
 * const databases = new CliDatabasesBuilder()
 *     .addDatabase('main', { connection: postgresConnection(pool), applyOnStartup: true })
 *     .addSqlFolder('main', './migrations')
 *     .build();
 * await databases.applyOnStartup();
 * mountPlugin(databases);
 * ```
 */
export class CliDatabasesBuilder {
    private readonly databases: Array<{ name: string; options: CliMigrationDatabaseOptions; sources: CliMigrationSource[] }> = [];
    private auditStore?: ICliAuditStore;
    private dashboardDir?: string | false;

    /** Registers a database (its name is used in the API, the terminal and the dashboard). */
    addDatabase(name: string, options: CliMigrationDatabaseOptions): this {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`invalid database name: ${name}`);
        if (this.databases.some((d) => d.name === name)) throw new Error(`database already added: ${name}`);
        this.databases.push({ name, options, sources: [] });
        return this;
    }

    /** Adds a source of migrations to a database; sources apply in the order they were added. */
    addSource(database: string, source: CliMigrationSource): this {
        const db = this.databases.find((d) => d.name === database);
        if (!db) throw new Error(`unknown database: ${database}`);
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
     * Where the dashboard's databases page is (`@qodalis/cli-dashboard-module-databases`'s build); by default the
     * copy next to the plugin, else the installed package. `false` leaves the page out.
     */
    setDashboardDir(dir: string | false): this {
        this.dashboardDir = dir;
        return this;
    }

    build(): CliDatabasesPluginResult {
        const databases = new CliDatabases();
        for (const db of this.databases) {
            const runner = new CliMigrationRunner(db.name, db.options);
            for (const source of db.sources) runner.addSource(source);
            databases.add(runner);
        }
        databases.setAuditStore(this.auditStore);
        const processor = new CliDatabasesCommandProcessor(databases);
        const pageDir = this.dashboardDir === false ? undefined : findDatabasesPage(this.dashboardDir);
        const page = pageDir ? databasesPage(pageDir) : undefined;
        return {
            prefix: DATABASES_PREFIX,
            router: createDatabasesController(databases),
            routePermissions: [{ path: DATABASES_PREFIX, read: DatabasesPermissions.Read, write: DatabasesPermissions.Migrate }],
            module: {
                name: 'databases',
                version: databasesInstalledPlugin.version ?? '1.0.0',
                description: 'Databases: size, load, largest tables and migrations',
                author: { name: 'Qodalis', email: 'nicolae.lupei@qodalis.com' },
                icon: '🗄️',
                processors: [processor],
            },
            permissions: DATABASES_PERMISSION_ENTRIES,
            installedPlugin: databasesInstalledPlugin,
            ...(page ? { dashboardPrefix: DATABASES_DASHBOARD_PREFIX, dashboardRouter: page.router } : {}),
            dashboardExtensions: page ? [page.extension] : [],
            mcpProviders: [new DatabasesMcpToolProvider(databases)],
            databases,
            setEventBus: (bus) => databases.setEventBus(bus),
            applyOnStartup: async () => {
                const runs: CliMigrationRun[] = [];
                for (const db of this.databases.filter((d) => d.options.applyOnStartup)) {
                    const run = await databases.run(db.name, 'up', { trigger: 'startup', wait: true });
                    runs.push(run);
                    if (run.status === 'failed') throw new Error(`migrations of ${db.name} failed: ${run.error}`);
                }
                return runs;
            },
        };
    }
}
