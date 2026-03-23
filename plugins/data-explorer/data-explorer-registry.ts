import {
    IDataExplorerProvider,
    DataExplorerProviderOptions,
    DataExplorerSourceInfo,
} from '@qodalis/cli-server-abstractions';

/** A registered data explorer provider paired with its configuration. */
export interface DataExplorerRegistryEntry {
    provider: IDataExplorerProvider;
    options: DataExplorerProviderOptions;
}

/** Registry mapping data source names to their providers and configuration. */
export class DataExplorerRegistry {
    private readonly _providers = new Map<string, DataExplorerRegistryEntry>();

    /** Register a provider under the name specified in its options. */
    register(provider: IDataExplorerProvider, options: DataExplorerProviderOptions): void {
        this._providers.set(options.name, { provider, options });
    }

    /** Look up a provider entry by source name. */
    get(name: string): DataExplorerRegistryEntry | undefined {
        return this._providers.get(name);
    }

    /** Return summary information for all registered sources. */
    getSources(): DataExplorerSourceInfo[] {
        return Array.from(this._providers.values()).map(({ options }) => ({
            name: options.name,
            description: options.description,
            language: options.language,
            defaultOutputFormat: options.defaultOutputFormat,
            templates: options.templates ?? [],
            parameters: options.parameters ?? [],
        }));
    }

    /** Number of registered data sources. */
    get size(): number {
        return this._providers.size;
    }
}
