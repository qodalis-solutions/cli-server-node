import {
    IDataExplorerProvider,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';
import { DataExplorerRegistry } from './data-explorer-registry';

export type DataExplorerProviderFactory = () => IDataExplorerProvider;

export class DataExplorerBuilder {
    private readonly _registry = new DataExplorerRegistry();

    addProvider(
        providerOrFactory: IDataExplorerProvider | DataExplorerProviderFactory,
        options: DataExplorerProviderOptions,
    ): DataExplorerBuilder {
        const provider =
            typeof providerOrFactory === 'function' ? providerOrFactory() : providerOrFactory;
        this._registry.register(provider, options);
        return this;
    }

    get registry(): DataExplorerRegistry {
        return this._registry;
    }
}
