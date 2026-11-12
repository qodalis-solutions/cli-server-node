import {
    IDataExplorerProvider,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerSchemaResult,
    DataExplorerSchemaTable,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';
import { Client, QueryConfig } from 'pg';
import { CLI_INSTALLED_PLUGIN, dataExplorerPostgresInstalledPlugin } from './package-info';

/** Connection configuration for the PostgreSQL data explorer provider. */
export interface PostgresConnectionOptions {
    /** PostgreSQL connection URI. */
    connectionString: string;
}

/** Data explorer provider for PostgreSQL databases using the `pg` client. */
export class PostgresDataExplorerProvider implements IDataExplorerProvider {
    /** The package this class belongs to, listed among the server's installed plugins. */
    static readonly [CLI_INSTALLED_PLUGIN] = dataExplorerPostgresInstalledPlugin;

    private readonly connectionOptions: PostgresConnectionOptions;

    constructor(connectionOptions: PostgresConnectionOptions) {
        this.connectionOptions = connectionOptions;
    }

    async executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult> {
        const startTime = Date.now();
        const client = new Client({ connectionString: this.connectionOptions.connectionString });
        try {
            await client.connect();
            // Read-only sources (the default): a read-only transaction, always rolled back
            const readOnly = (context.options as { readOnly?: boolean }).readOnly !== false;
            if (readOnly) await client.query('BEGIN READ ONLY');
            let result;
            try {
                // The extended protocol runs one statement, so a `COMMIT; …` cannot end the transaction
                result = await client.query({ text: context.query, queryMode: 'extended' } as QueryConfig);
            } finally {
                if (readOnly) await client.query('ROLLBACK').catch(() => undefined);
            }
            const columns = result.fields.map((f) => f.name);
            const rows = result.rows.map((row) => columns.map((col) => row[col]));
            return {
                success: true,
                source: context.options.name,
                language: context.options.language,
                defaultOutputFormat: context.options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
                columns,
                rows,
                rowCount: rows.length,
                truncated: false,
                error: null,
            };
        } catch (error) {
            return {
                success: false,
                source: context.options.name,
                language: context.options.language,
                defaultOutputFormat: context.options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
                columns: null,
                rows: [],
                rowCount: 0,
                truncated: false,
                error: error instanceof Error ? error.message : String(error),
            };
        } finally {
            await client.end();
        }
    }

    async getSchemaAsync(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult> {
        const client = new Client({ connectionString: this.connectionOptions.connectionString });
        try {
            await client.connect();

            const tablesResult = await client.query<{ table_name: string; table_type: string }>(
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
            );

            const tables: DataExplorerSchemaTable[] = await Promise.all(
                tablesResult.rows.map(async (t) => {
                    const columnsResult = await client.query<{
                        column_name: string;
                        data_type: string;
                        is_nullable: string;
                    }>(
                        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
                        [t.table_name]
                    );

                    // Detect primary key columns via table constraints
                    const pkResult = await client.query<{ column_name: string }>(
                        `SELECT kcu.column_name
                         FROM information_schema.table_constraints tc
                         JOIN information_schema.key_column_usage kcu
                           ON tc.constraint_name = kcu.constraint_name
                          AND tc.table_schema = kcu.table_schema
                         WHERE tc.constraint_type = 'PRIMARY KEY'
                           AND tc.table_schema = 'public'
                           AND tc.table_name = $1`,
                        [t.table_name]
                    );
                    const pkColumns = new Set(pkResult.rows.map((r) => r.column_name));

                    return {
                        name: t.table_name,
                        type: t.table_type === 'VIEW' ? 'view' : 'table',
                        columns: columnsResult.rows.map((c) => ({
                            name: c.column_name,
                            type: c.data_type,
                            nullable: c.is_nullable === 'YES',
                            primaryKey: pkColumns.has(c.column_name),
                        })),
                    };
                })
            );

            return { source: options.name, tables };
        } finally {
            await client.end();
        }
    }
}
