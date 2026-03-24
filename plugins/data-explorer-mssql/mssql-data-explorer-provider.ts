import {
    IDataExplorerProvider,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerSchemaResult,
    DataExplorerSchemaTable,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';
import * as sql from 'mssql';

/** Connection configuration for the MSSQL data explorer provider. */
export interface MssqlConnectionOptions {
    /** SQL Server connection string. */
    connectionString: string;
}

/** Data explorer provider for Microsoft SQL Server using the mssql package. */
export class MssqlDataExplorerProvider implements IDataExplorerProvider {
    private readonly connectionOptions: MssqlConnectionOptions;

    constructor(connectionOptions: MssqlConnectionOptions) {
        this.connectionOptions = connectionOptions;
    }

    async executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult> {
        const startTime = Date.now();
        let pool: sql.ConnectionPool | null = null;
        try {
            pool = await sql.connect(this.connectionOptions.connectionString);
            const result = await pool.request().query(context.query);

            const recordset = result.recordset ?? [];
            const columns =
                recordset.columns != null
                    ? Object.keys(recordset.columns)
                    : recordset.length > 0
                      ? Object.keys(recordset[0] as Record<string, unknown>)
                      : [];

            const rows = recordset.map((row: Record<string, unknown>) =>
                columns.map((col) => row[col]),
            );

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
            if (pool) {
                await pool.close();
            }
        }
    }

    async getSchemaAsync(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult> {
        let pool: sql.ConnectionPool | null = null;
        try {
            pool = await sql.connect(this.connectionOptions.connectionString);

            const tablesResult = await pool
                .request()
                .query(
                    "SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' ORDER BY TABLE_NAME",
                );

            const tables: DataExplorerSchemaTable[] = await Promise.all(
                (tablesResult.recordset as { TABLE_NAME: string; TABLE_TYPE: string }[]).map(
                    async (t) => {
                        const columnsResult = await pool!
                            .request()
                            .input('tableName', sql.NVarChar, t.TABLE_NAME)
                            .query(
                                `SELECT
                                    COLUMN_NAME,
                                    DATA_TYPE,
                                    IS_NULLABLE,
                                    COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA + '.' + TABLE_NAME), COLUMN_NAME, 'IsIdentity') as IS_IDENTITY
                                FROM INFORMATION_SCHEMA.COLUMNS
                                WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @tableName
                                ORDER BY ORDINAL_POSITION`,
                            );

                        const cols = columnsResult.recordset as {
                            COLUMN_NAME: string;
                            DATA_TYPE: string;
                            IS_NULLABLE: string;
                            IS_IDENTITY: number | null;
                        }[];

                        return {
                            name: t.TABLE_NAME,
                            type: t.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
                            columns: cols.map((c) => ({
                                name: c.COLUMN_NAME,
                                type: c.DATA_TYPE,
                                nullable: c.IS_NULLABLE === 'YES',
                                primaryKey: c.IS_IDENTITY === 1,
                            })),
                        };
                    },
                ),
            );

            return { source: options.name, tables };
        } finally {
            if (pool) {
                await pool.close();
            }
        }
    }
}
