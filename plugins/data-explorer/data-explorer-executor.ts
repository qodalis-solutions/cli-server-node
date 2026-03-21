import {
    DataExplorerExecuteRequest,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerLanguage,
    DataExplorerOutputFormat,
} from '@qodalis/cli-server-abstractions';
import { DataExplorerRegistry } from './data-explorer-registry';

export class DataExplorerExecutor {
    constructor(private readonly registry: DataExplorerRegistry) {}

    async executeAsync(request: DataExplorerExecuteRequest): Promise<DataExplorerResult> {
        const entry = this.registry.get(request.source);
        if (!entry) {
            return {
                success: false,
                source: request.source,
                language: DataExplorerLanguage.Sql,
                defaultOutputFormat: DataExplorerOutputFormat.Table,
                executionTime: 0,
                columns: null,
                rows: [],
                rowCount: 0,
                truncated: false,
                error: `Unknown data source: '${request.source}'`,
            };
        }

        const { provider, options } = entry;
        const timeoutMs = options.timeout ?? 30000;

        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);

        const context: DataExplorerExecutionContext = {
            query: request.query,
            parameters: request.parameters ?? {},
            options,
            signal: abortController.signal,
        };

        const startTime = Date.now();

        try {
            const result = await provider.executeAsync(context);
            clearTimeout(timer);

            // Enforce maxRows
            if (options.maxRows && result.rows.length > options.maxRows) {
                result.rows = result.rows.slice(0, options.maxRows);
                result.rowCount = result.rows.length;
                result.truncated = true;
            }

            return result;
        } catch (err: any) {
            clearTimeout(timer);

            const message = abortController.signal.aborted
                ? `Query timed out after ${timeoutMs}ms`
                : err.message ?? String(err);

            return {
                success: false,
                source: request.source,
                language: options.language,
                defaultOutputFormat: options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
                columns: null,
                rows: [],
                rowCount: 0,
                truncated: false,
                error: message,
            };
        }
    }
}
