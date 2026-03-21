import {
    IDataExplorerProvider,
    DataExplorerExecutionContext,
    DataExplorerResult,
} from '@qodalis/cli-server-abstractions';

export interface SqlConnectionOptions {
    type: 'sqlite' | 'postgres' | 'mysql';
    connectionString?: string;
    filename?: string;
}

export class SqlDataExplorerProvider implements IDataExplorerProvider {
    private readonly connectionOptions: SqlConnectionOptions;

    constructor(connectionOptions: SqlConnectionOptions) {
        this.connectionOptions = connectionOptions;
    }

    async executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult> {
        const startTime = Date.now();
        try {
            const result = await this.executeSqlite(context);
            return {
                ...result,
                source: context.options.name,
                language: context.options.language,
                defaultOutputFormat: context.options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
            } as DataExplorerResult;
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
        }
    }

    private async executeSqlite(
        context: DataExplorerExecutionContext,
    ): Promise<Partial<DataExplorerResult>> {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(this.connectionOptions.filename ?? ':memory:');
        try {
            const stmt = db.prepare(context.query);
            if (stmt.reader) {
                const rows = stmt.all(context.parameters ?? {});
                const columns =
                    rows.length > 0
                        ? Object.keys(rows[0] as Record<string, unknown>)
                        : [];
                const arrayRows = rows.map((row) =>
                    columns.map((col) => (row as Record<string, unknown>)[col]),
                );
                return {
                    success: true,
                    columns,
                    rows: arrayRows,
                    rowCount: arrayRows.length,
                    truncated: false,
                    error: null,
                };
            } else {
                const info = stmt.run(context.parameters ?? {});
                return {
                    success: true,
                    columns: ['changes', 'lastInsertRowid'],
                    rows: [[info.changes, Number(info.lastInsertRowid)]],
                    rowCount: 1,
                    truncated: false,
                    error: null,
                };
            }
        } finally {
            db.close();
        }
    }
}
