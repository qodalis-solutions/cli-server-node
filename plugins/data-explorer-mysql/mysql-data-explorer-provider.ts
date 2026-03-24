import {
    IDataExplorerProvider,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerSchemaResult,
    DataExplorerSchemaTable,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';
import * as mysql from 'mysql2/promise';
import type { FieldPacket, RowDataPacket } from 'mysql2/promise';

/** Connection configuration for the MySQL data explorer provider. */
export interface MysqlConnectionOptions {
    /** MySQL connection URI. */
    connectionString: string;
}

/** Data explorer provider for MySQL databases using mysql2. */
export class MysqlDataExplorerProvider implements IDataExplorerProvider {
    private readonly connectionOptions: MysqlConnectionOptions;

    constructor(connectionOptions: MysqlConnectionOptions) {
        this.connectionOptions = connectionOptions;
    }

    async executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult> {
        const startTime = Date.now();
        const connection = await mysql.createConnection(this.connectionOptions.connectionString);
        try {
            const [rows, fields] = await connection.execute<RowDataPacket[]>(context.query);
            const typedFields = fields as FieldPacket[];
            const columns = typedFields.map((f) => f.name);
            const arrayRows = (rows as Record<string, unknown>[]).map((row) =>
                columns.map((col) => row[col]),
            );
            return {
                success: true,
                source: context.options.name,
                language: context.options.language,
                defaultOutputFormat: context.options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
                columns,
                rows: arrayRows,
                rowCount: arrayRows.length,
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
            await connection.end();
        }
    }

    async getSchemaAsync(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult> {
        const connection = await mysql.createConnection(this.connectionOptions.connectionString);
        try {
            const [tableRows] = await connection.execute<RowDataPacket[]>(
                'SELECT TABLE_NAME as table_name, TABLE_TYPE as table_type FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
            );

            const tables: DataExplorerSchemaTable[] = [];
            for (const tableRow of tableRows as { table_name: string; table_type: string }[]) {
                const [columnRows] = await connection.execute<RowDataPacket[]>(
                    'SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
                    [tableRow.table_name],
                );
                tables.push({
                    name: tableRow.table_name,
                    type: tableRow.table_type === 'VIEW' ? 'view' : 'table',
                    columns: (
                        columnRows as {
                            COLUMN_NAME: string;
                            DATA_TYPE: string;
                            IS_NULLABLE: string;
                            COLUMN_KEY: string;
                        }[]
                    ).map((c) => ({
                        name: c.COLUMN_NAME,
                        type: c.DATA_TYPE,
                        nullable: c.IS_NULLABLE === 'YES',
                        primaryKey: c.COLUMN_KEY === 'PRI',
                    })),
                });
            }

            return { source: options.name, tables };
        } finally {
            await connection.end();
        }
    }
}
