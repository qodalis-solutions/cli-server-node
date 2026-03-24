import {
    IDataExplorerProvider,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';
import { DataExplorerRegistry } from './data-explorer-registry';

/** Factory function that creates a data explorer provider on demand. */
export type DataExplorerProviderFactory = () => IDataExplorerProvider;

/**
 * Fluent builder for registering data explorer providers with their options.
 * Use {@link registry} to access the populated registry after configuration.
 */
export class DataExplorerBuilder {
    private readonly _registry = new DataExplorerRegistry();

    /**
     * Register a data explorer provider (or lazy factory) with the given options.
     *
     * @param providerOrFactory - A provider instance or a factory function.
     * @param options - Configuration including name, language, and query templates.
     */
    addProvider(
        providerOrFactory: IDataExplorerProvider | DataExplorerProviderFactory,
        options: DataExplorerProviderOptions,
    ): DataExplorerBuilder {
        const provider =
            typeof providerOrFactory === 'function' ? providerOrFactory() : providerOrFactory;
        this._registry.register(provider, options);
        return this;
    }

    /** The underlying registry containing all registered providers. */
    get registry(): DataExplorerRegistry {
        return this._registry;
    }
}
