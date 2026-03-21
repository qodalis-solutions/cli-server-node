import { DataExplorerExecutionContext, DataExplorerResult, DataExplorerSchemaResult, DataExplorerProviderOptions } from './data-explorer-types';

export interface IDataExplorerProvider {
    executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult>;
    getSchemaAsync?(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult>;
}
