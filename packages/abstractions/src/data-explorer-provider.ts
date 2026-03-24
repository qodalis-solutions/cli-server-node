import { DataExplorerExecutionContext, DataExplorerResult, DataExplorerSchemaResult, DataExplorerProviderOptions } from './data-explorer-types';

/** Provider that executes queries against a specific data source (e.g. SQL database, MongoDB). */
export interface IDataExplorerProvider {
    /**
     * Executes a query against the data source.
     * @param context - Execution context containing the query, parameters, and options.
     * @returns Query results including rows, columns, and execution metadata.
     */
    executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult>;
    /**
     * Retrieves schema information (tables, columns) from the data source.
     * @param options - Provider options identifying the data source.
     * @returns Schema metadata for the data source.
     */
    getSchemaAsync?(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult>;
}
