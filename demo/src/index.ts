import {
    createCliServer,
    CliSystemCommandProcessor,
    CliHttpCommandProcessor,
    CliHashCommandProcessor,
    CliBase64CommandProcessor,
} from '@qodalis/cli-server-node';
import { CliEchoCommandProcessor } from './processors/cli-echo-command-processor';
import { CliStatusCommandProcessor } from './processors/cli-status-command-processor';
import { CliTimeCommandProcessor } from './processors/cli-time-command-processor';
import { CliHelloCommandProcessor } from './processors/cli-hello-command-processor';
import { CliMathCommandProcessor } from './processors/cli-math-command-processor';
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
import { SampleHealthCheckJob } from './sample-health-check-job';

// File storage providers — uncomment the one you want to use:
import { InMemoryFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
// import { OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
// import { JsonFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-json';
// import { SqliteFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-sqlite';
// import { S3FileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-s3';

const port = process.env.PORT ?? 8047;

const { app, registry, builder, eventSocketManager, logSocketManager } = createCliServer({
    configure: (builder) => {
        builder
            .addProcessor(new CliEchoCommandProcessor())
            .addProcessor(new CliStatusCommandProcessor())
            .addProcessor(new CliTimeCommandProcessor())
            .addProcessor(new CliHelloCommandProcessor())
            .addProcessor(new CliMathCommandProcessor())
            .addProcessor(new CliSystemCommandProcessor())
            .addProcessor(new CliHttpCommandProcessor())
            .addProcessor(new CliHashCommandProcessor())
            .addProcessor(new CliBase64CommandProcessor())
            .addModule(new WeatherModule())
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
                    defaultOutputFormat: DataExplorerOutputFormat.Table,
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
        interval: '30s',
    })
    .build((msg) => eventSocketManager.broadcastMessage(msg));

app.use('/api/v1/qcli/jobs', jobsPlugin.router);

// -----------------------------------------------------------
// Admin Dashboard (via plugin)
// -----------------------------------------------------------
const adminPlugin = new CliAdminBuilder()
    .setCredentials(
        process.env.QCLI_ADMIN_USERNAME ?? 'admin',
        process.env.QCLI_ADMIN_PASSWORD ?? 'admin',
    )
    .setRegisteredJobs(1) // number of registered jobs above
    .build({
        registry,
        eventSocketManager,
        builder,
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

app.use('/api/v1/qcli', adminPlugin.router);
app.use('/qcli/admin', adminPlugin.dashboardRouter);

const server = app.listen(port, () => {
    console.log(`CLI demo server (Node.js) listening on http://localhost:${port}`);
    console.log(`  Commands:  http://localhost:${port}/api/qcli/commands`);
    console.log(`  Execute:   http://localhost:${port}/api/qcli/execute`);
    console.log(`  Jobs:      http://localhost:${port}/api/v1/qcli/jobs`);
    console.log(`  Admin API: http://localhost:${port}/api/v1/qcli/status`);
    console.log(`  Dashboard: http://localhost:${port}/qcli/admin/`);
    console.log(`  Events:    ws://localhost:${port}/ws/qcli/events`);
    console.log(`  Logs WS:   ws://localhost:${port}/ws/qcli/logs`);

    jobsPlugin.scheduler.start().catch((err) => {
        console.error('Failed to start job scheduler:', err);
    });
});

eventSocketManager.attach(server);
logSocketManager.attach(server);

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await jobsPlugin.scheduler.stop();
    await eventSocketManager.broadcastDisconnect();
    await logSocketManager.broadcastDisconnect();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await jobsPlugin.scheduler.stop();
    await eventSocketManager.broadcastDisconnect();
    await logSocketManager.broadcastDisconnect();
    server.close();
    process.exit(0);
});
