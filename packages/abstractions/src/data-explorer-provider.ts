import { DataExplorerExecutionContext, DataExplorerResult } from './data-explorer-types';

export interface IDataExplorerProvider {
    executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult>;
}
