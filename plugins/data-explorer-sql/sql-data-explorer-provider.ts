import {
    IDataExplorerProvider,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerSchemaResult,
    DataExplorerSchemaTable,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';

/** Connection configuration for the SQL data explorer provider. */
export interface SqlConnectionOptions {
    /** Database engine type. */
    type: 'sqlite' | 'postgres' | 'mysql';
    /** Connection string (used for postgres/mysql). */
    connectionString?: string;
    /** SQLite database file path (defaults to ':memory:'). */
    filename?: string;
}

/** Data explorer provider for SQLite databases using better-sqlite3. */
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

    async getSchemaAsync(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult> {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(this.connectionOptions.filename ?? ':memory:');
        try {
            const tables = db.prepare(
                "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).all() as { name: string; type: string }[];

            const result: DataExplorerSchemaTable[] = tables.map((t) => {
                const columns = db.prepare(`PRAGMA table_info("${t.name}")`).all() as {
                    name: string;
                    type: string;
                    notnull: number;
                    pk: number;
                }[];
                return {
                    name: t.name,
                    type: t.type,
                    columns: columns.map((c) => ({
                        name: c.name,
                        type: c.type || 'TEXT',
                        nullable: c.notnull === 0,
                        primaryKey: c.pk > 0,
                    })),
                };
            });

            return { source: options.name, tables: result };
        } finally {
            db.close();
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
