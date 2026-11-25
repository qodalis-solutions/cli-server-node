import {
    createCliServer,
    CliHttpCommandProcessor,
    CliStoredConfigProvider,
    JsonFileConfigStore,
} from '@qodalis/cli-server-node';
import { DemoModule } from './demo-module';
import { WeatherModule } from '@qodalis/cli-server-plugin-weather';
import { SqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-sql';
import { PostgresDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-postgres';
import { MysqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-mysql';
import { MssqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-mssql';
import { RedisDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-redis';
import { ElasticsearchDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-elasticsearch';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { CliAdminBuilder } from '@qodalis/cli-server-plugin-admin';
import { AwsModule } from '@qodalis/cli-server-plugin-aws';
import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';
import { CliDatabaseConfigStore, CliDatabasesBuilder, postgresConnection, sqliteConnection } from '@qodalis/cli-server-plugin-databases';
import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import { SampleHealthCheckJob } from './sample-health-check-job';
import { addPublicApi } from './public-api';

// File storage providers — uncomment the one you want to use:
import { InMemoryFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
// import { OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
// import { JsonFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-json';
// import { SqliteFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-sqlite';
// import { S3FileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-s3';

const port = process.env.PORT ?? 8047;

// Browser origins allowed for CORS and WebSocket upgrades (local dev apps + the
// admin dashboard served by this server). Override with QCLI_ALLOWED_ORIGINS.
const allowedOrigins = process.env.QCLI_ALLOWED_ORIGINS
    ? process.env.QCLI_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [
          'http://localhost:4200',
          'http://localhost:4300',
          'http://localhost:4301',
          'http://localhost:4302',
          'http://localhost:4303',
          `http://localhost:${port}`,
          'http://127.0.0.1:*',
      ];

// The demo's SQLite database (the databases plugin below shows its migrations; it also keeps the jobs settings)
const demoDb = sqliteConnection(new Database(process.env.QCLI_DEMO_DB ?? path.join(os.tmpdir(), 'qcli-demo.sqlite')));

// -----------------------------------------------------------
// Config stores: settings changed from the dashboard's Config page, `config set` or MCP `config_set` are kept
// and applied again at the next start. Each provider may keep its settings in a store of its own:
//
//   - the default store, for every provider without one: a JSON file (QCLI_DEMO_CONFIG). To keep them in a
//     section of the app's own settings file instead: new JsonFileConfigStore('config/app.json', { section: 'qcli' })
//   - `jobs` (history retention): the demo's SQLite database, table QcliConfig (migration source qcli-config,
//     shown on the Databases page), set by id with `config.stores` (the host's choice wins over the plugin's)
//   - `demo` (the app's own settings below): Redis when QCLI_DEMO_REDIS_URL is set (redis://localhost:6379/0),
//     through the provider's own `store` option; else the default store
//
// `config list` and GET /api/v1/qcli/config show the store of every provider.
// -----------------------------------------------------------
const configStore = new JsonFileConfigStore(process.env.QCLI_DEMO_CONFIG ?? path.join(os.tmpdir(), 'qcli-demo-config.json'));
const jobsConfigStore = new CliDatabaseConfigStore({ connection: demoDb });
const redisConfigStore = process.env.QCLI_DEMO_REDIS_URL
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      new (require('@qodalis/cli-server-plugin-config-redis') as typeof import('@qodalis/cli-server-plugin-config-redis')).CliRedisConfigStore({
          url: process.env.QCLI_DEMO_REDIS_URL,
      })
    : undefined;

// A host app's own settings: what the demo's greeting says, and a secret it never shows
const greeting = { text: 'Hello from the Qodalis CLI demo', apiKey: null as string | null };
const demoConfig = new CliStoredConfigProvider({
    id: 'demo',
    title: 'Demo app',
    description: "The demo host application's own settings",
    // Its own store: Redis with QCLI_DEMO_REDIS_URL, else (undefined) the default store
    store: redisConfigStore,
    sections: [
        {
            id: 'greeting',
            title: 'Greeting',
            settings: [
                {
                    key: 'text',
                    label: 'Greeting',
                    type: 'string',
                    default: greeting.text,
                    validation: { required: true, max: 120 },
                    apply: (v) => (greeting.text = String(v)),
                },
                {
                    key: 'apiKey',
                    label: 'Partner API key',
                    description: 'Never shown, only whether it is set',
                    type: 'secret',
                    apply: (v) => (greeting.apiKey = (v as string | null) ?? null),
                },
            ],
        },
    ],
});

const { app, registry, builder, executor, eventSocketManager, logSocketManager, eventBus, mountPlugin, config, restart } = createCliServer({
    allowedOrigins,
    // Restart from the dashboard or `admin restart --yes`: the demo runs bare (npx tsx, nohup), with no supervisor,
    // so it starts itself again ('self': same command, environment and log file). Under Docker, systemd or PM2
    // leave the mode out ('auto' exits with 75 for the supervisor to start it again).
    restart: { mode: 'self' },
    config: { store: configStore, stores: { jobs: jobsConfigStore } },
    // The demo exposes the interactive shell. The users plugin is mounted below, so
    // the shell runs in "users" mode: a WS ticket from a session holding
    // shell:execute (root has '*'). Without the users plugin, set shell.token
    // (or shell.authorize) instead; with no mode at all the shell stays locked.
    enableShell: true,
    shell: {
        maxSessionsPerUser: 3,
        idleTimeoutMs: 15 * 60 * 1000,
        // The shell gets a minimal environment; allow-list extra variables here.
        env: { allow: ['NODE_ENV'] },
    },
    // MCP endpoint (POST /api/qcli/mcp): AI clients call the commands as tools.
    // Protected by the users plugin: sign in, create an API token
    // (POST /api/v1/qcli/tokens) and send it as `Authorization: Bearer qcli_pat_…`.
    mcp: {
        instructions: 'Qodalis CLI demo server: each tool runs one CLI command.',
    },
    configure: (builder) => {
        builder.addConfigProvider(demoConfig);
        builder
            .addModule(new DemoModule())
            .addProcessor(new CliHttpCommandProcessor())
            .addModule(new WeatherModule())
            .addModule(new AwsModule())
            .addFileSystem({ allowedPaths: ['/tmp', '/app', '/home'] });

        // -----------------------------------------------------------
        // Data Explorer — SQL Provider
        // -----------------------------------------------------------
        builder.addDataExplorerProvider(
            new SqlDataExplorerProvider({ type: 'sqlite', filename: './demo.db' }),
            {
                name: 'demo-sqlite',
                description: 'Demo SQLite database',
                language: DataExplorerLanguage.Sql,
                defaultOutputFormat: DataExplorerOutputFormat.Table,
                timeout: 30000,
                maxRows: 1000,
                templates: [
                    {
                        name: 'list_tables',
                        query: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
                        description: 'List all tables in the database',
                    },
                ],
            },
        );

        // -----------------------------------------------------------
        // Data Explorer — MongoDB Provider
        // -----------------------------------------------------------
        const mongoConnectionString = process.env.MONGO_CONNECTION_STRING;
        if (mongoConnectionString) {
            const { MongoDataExplorerProvider } = require('@qodalis/cli-server-plugin-data-explorer-mongo');
            builder.addDataExplorerProvider(
                new MongoDataExplorerProvider({
                    connectionString: mongoConnectionString,
                    database: 'demo',
                }),
                {
                    name: 'demo-mongo',
                    description: 'Demo MongoDB database',
                    language: DataExplorerLanguage.Json,
                    defaultOutputFormat: DataExplorerOutputFormat.Json,
                    timeout: 30000,
                    maxRows: 1000,
                    templates: [
                        {
                            name: 'show_collections',
                            query: 'show collections',
                            description: 'List all collections',
                        },
                        {
                            name: 'find_all',
                            query: 'db.users.find({})',
                            description: 'Find all documents in users collection',
                        },
                    ],
                },
            );
        }

        // -----------------------------------------------------------
        // Data Explorer — PostgreSQL Provider
        // -----------------------------------------------------------
        const pgConnectionString = process.env.POSTGRES_CONNECTION_STRING;
        if (pgConnectionString) {
            builder.addDataExplorerProvider(
                new PostgresDataExplorerProvider({ connectionString: pgConnectionString }),
                {
                    name: 'demo-postgres',
                    description: 'Demo PostgreSQL database',
                    language: DataExplorerLanguage.Sql,
                    defaultOutputFormat: DataExplorerOutputFormat.Table,
                    timeout: 30000,
                    maxRows: 1000,
                    templates: [],
                },
            );
        }

        // -----------------------------------------------------------
        // Data Explorer — MySQL Provider
        // -----------------------------------------------------------
        const mysqlConnectionString = process.env.MYSQL_CONNECTION_STRING;
        if (mysqlConnectionString) {
            builder.addDataExplorerProvider(
                new MysqlDataExplorerProvider({ connectionString: mysqlConnectionString }),
                {
                    name: 'demo-mysql',
                    description: 'Demo MySQL database',
                    language: DataExplorerLanguage.Sql,
                    defaultOutputFormat: DataExplorerOutputFormat.Table,
                    timeout: 30000,
                    maxRows: 1000,
                    templates: [],
                },
            );
        }

        // -----------------------------------------------------------
        // Data Explorer — MS SQL Provider
        // -----------------------------------------------------------
        const mssqlConnectionString = process.env.MSSQL_CONNECTION_STRING;
        if (mssqlConnectionString) {
            builder.addDataExplorerProvider(
                new MssqlDataExplorerProvider({ connectionString: mssqlConnectionString }),
                {
                    name: 'demo-mssql',
                    description: 'Demo MS SQL Server database',
                    language: DataExplorerLanguage.Sql,
                    defaultOutputFormat: DataExplorerOutputFormat.Table,
                    timeout: 30000,
                    maxRows: 1000,
                    templates: [],
                },
            );
        }

        // -----------------------------------------------------------
        // Data Explorer — Redis Provider
        // -----------------------------------------------------------
        const redisConnectionString = process.env.REDIS_CONNECTION_STRING;
        if (redisConnectionString) {
            builder.addDataExplorerProvider(
                new RedisDataExplorerProvider({ connectionString: redisConnectionString }),
                {
                    name: 'demo-redis',
                    description: 'Demo Redis instance',
                    language: DataExplorerLanguage.Redis,
                    defaultOutputFormat: DataExplorerOutputFormat.Table,
                    timeout: 30000,
                    maxRows: 1000,
                    templates: [],
                },
            );
        }

        // -----------------------------------------------------------
        // Data Explorer — Elasticsearch Provider
        // -----------------------------------------------------------
        const esNode = process.env.ELASTICSEARCH_NODE;
        if (esNode) {
            builder.addDataExplorerProvider(
                new ElasticsearchDataExplorerProvider({ node: esNode }),
                {
                    name: 'demo-elasticsearch',
                    description: 'Demo Elasticsearch cluster',
                    language: DataExplorerLanguage.Elasticsearch,
                    defaultOutputFormat: DataExplorerOutputFormat.Json,
                    timeout: 30000,
                    maxRows: 1000,
                    templates: [],
                },
            );
        }

        // -----------------------------------------------------------
        // File Storage Provider Configuration
        // -----------------------------------------------------------
        // By default, InMemoryFileStorageProvider is used. You can
        // switch to a different provider using setFileStorageProvider().
        //
        // Option 1: In-memory (default — files are lost on restart)
        builder.setFileStorageProvider(new InMemoryFileStorageProvider());

        // Option 2: OS filesystem (reads/writes real files on disk)
        // builder.setFileStorageProvider(
        //     new OsFileStorageProvider({ allowedPaths: ['/tmp', '/app', '/home'] })
        // );

        // Option 3: JSON file (persists virtual filesystem to a single JSON file)
        // builder.setFileStorageProvider(
        //     new JsonFileStorageProvider({ filePath: './data.json' })
        // );

        // Option 4: SQLite (persists virtual filesystem to a SQLite database)
        // builder.setFileStorageProvider(
        //     new SqliteFileStorageProvider({ dbPath: './files.db' })
        // );

        // Option 5: Amazon S3 (store files in an S3 bucket)
        // builder.setFileStorageProvider(
        //     new S3FileStorageProvider({
        //         bucket: 'my-cli-files',
        //         region: 'us-east-1',
        //         // accessKeyId and secretAccessKey can also come from
        //         // environment variables or IAM roles
        //     })
        // );
    },
});

// -----------------------------------------------------------
// Background Jobs (via plugin)
// -----------------------------------------------------------
const jobsPlugin = new CliJobsBuilder()
    .addJob(new SampleHealthCheckJob(), {
        name: 'health-check',
        description: 'Periodic health check',
        group: 'monitoring',
        tags: ['health', 'demo'],
        interval: '30s',
    })
    .build(eventBus);

mountPlugin(jobsPlugin);

// -----------------------------------------------------------
// Users Plugin (users, groups/permissions, sessions, API tokens); it adds
// the audit plugin and serves its API at /api/v1/qcli/audit.
// Mounting it protects every server route and socket (protectServer).
// -----------------------------------------------------------
const usersPlugin = new CliUsersBuilder()
    // Demo-only well-known password (a startup warning is logged).
    .setDefaultAdminPassword('admin')
    .setAllowedOrigins(allowedOrigins)
    .build(eventBus);

// -----------------------------------------------------------
// Admin Dashboard (via plugin) — authenticates through the users plugin
// and requires the admin:access permission (root/admin has it via '*').
// -----------------------------------------------------------
const adminPlugin = new CliAdminBuilder()
    .setAuthProvider(usersPlugin.serverAuth)
    .setRegisteredJobs(1) // number of registered jobs above
    .build({
        registry,
        eventSocketManager,
        builder,
        executor,
        broadcastFn: (msg) => {
            eventSocketManager.broadcastMessage(msg);
            // Also stream to dedicated log WebSocket clients
            if (msg.type === 'log:entry') {
                logSocketManager.broadcastLog(
                    String(msg.level ?? 'information'),
                    String(msg.message ?? ''),
                    msg.source ? String(msg.source) : undefined,
                );
            }
        },
    });

mountPlugin(adminPlugin);
mountPlugin(usersPlugin);

// -----------------------------------------------------------
// Databases: a demo SQLite database with three migrations, left pending so
// the dashboard's Databases page and `databases up demo` have work to do.
// QCLI_DEMO_POSTGRES (a connection string) adds a PostgreSQL database, to see
// a server's connections and load.
// -----------------------------------------------------------
const databasesBuilder = new CliDatabasesBuilder()
    .addDatabase('demo', { connection: demoDb })
    // The jobs settings' table (QcliConfig), applied by the store itself at startup
    .addSource('demo', jobsConfigStore.migrationSource)
    .addMigrations('demo', 'app', [
        {
            id: '0001',
            name: 'create notes',
            up: 'CREATE TABLE Notes (Id INTEGER PRIMARY KEY, Title TEXT NOT NULL, CreatedAt TEXT NOT NULL)',
            down: 'DROP TABLE Notes',
        },
        {
            id: '0002',
            name: 'create tags',
            up: 'CREATE TABLE Tags (Id INTEGER PRIMARY KEY, Name TEXT NOT NULL UNIQUE)',
            down: 'DROP TABLE Tags',
        },
        {
            id: '0003',
            name: 'index notes by date',
            up: 'CREATE INDEX IX_Notes_CreatedAt ON Notes (CreatedAt)',
            down: 'DROP INDEX IX_Notes_CreatedAt',
        },
    ]);
if (process.env.QCLI_DEMO_POSTGRES) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require('pg') as typeof import('pg');
    databasesBuilder.addDatabase('postgres', { connection: postgresConnection(new Pool({ connectionString: process.env.QCLI_DEMO_POSTGRES, max: 4 })) });
}
const databasesPlugin = databasesBuilder.build();
mountPlugin(databasesPlugin);

// -----------------------------------------------------------
// Public API (host tokens, quotas, OpenAPI + Swagger UI), guides and the portal
// -----------------------------------------------------------
addPublicApi({ app, builder, mountPlugin }, usersPlugin);

// A restart's graceful shutdown stops the jobs and disposes the mounted plugins itself; the host closes its own stores
restart.onShutdown('redis config store', () => redisConfigStore?.close());

// Stored settings are applied once every store has loaded them (the file at once, the database once its table exists)
config.ready().catch((err) => console.error('[demo] config store failed:', err));

const server = app.listen(port, () => {
    console.log(`CLI demo server (Node.js) listening on http://localhost:${port}`);
    console.log(`  Commands:  http://localhost:${port}/api/qcli/commands`);
    console.log(`  Execute:   http://localhost:${port}/api/qcli/execute`);
    console.log(`  Jobs:      http://localhost:${port}/api/v1/qcli/jobs`);
    console.log(`  Admin API: http://localhost:${port}/api/v1/qcli/status`);
    console.log(`  Dashboard: http://localhost:${port}/qcli/admin/`);
    console.log(`  Users API: http://localhost:${port}/api/v1/qcli/users`);
    console.log(`  MCP:       http://localhost:${port}/api/qcli/mcp`);
    console.log(`  Databases: http://localhost:${port}/api/v1/qcli/databases`);
    console.log(`  Portal:    http://localhost:${port}/qcli/portal/`);
    console.log(`  Swagger:   http://localhost:${port}/qcli/api/swagger`);
    console.log(`  Public:    http://localhost:${port}/v1/demo/time (host token, demo:read)`);
    console.log(`  Events:    ws://localhost:${port}/ws/qcli/events`);
    console.log(`  Logs WS:   ws://localhost:${port}/ws/qcli/logs`);

    jobsPlugin.scheduler.start().catch((err) => {
        console.error('Failed to start job scheduler:', err);
    });
});

eventSocketManager.attach(server);
logSocketManager.attach(server);

const shutdown = async () => {
    await jobsPlugin.scheduler.stop();
    usersPlugin.dispose();
    await redisConfigStore?.close();
    await eventSocketManager.broadcastDisconnect();
    await logSocketManager.broadcastDisconnect();
    server.close();
    process.exit(0);
};

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await shutdown();
});

process.on('SIGTERM', shutdown);
