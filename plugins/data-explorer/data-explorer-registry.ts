import {
    IDataExplorerProvider,
    DataExplorerProviderOptions,
    DataExplorerSourceInfo,
} from '@qodalis/cli-server-abstractions';

export interface DataExplorerRegistryEntry {
    provider: IDataExplorerProvider;
    options: DataExplorerProviderOptions;
}

export class DataExplorerRegistry {
    private readonly _providers = new Map<string, DataExplorerRegistryEntry>();

    register(provider: IDataExplorerProvider, options: DataExplorerProviderOptions): void {
        this._providers.set(options.name, { provider, options });
    }

    get(name: string): DataExplorerRegistryEntry | undefined {
        return this._providers.get(name);
    }

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

    get size(): number {
        return this._providers.size;
    }
}
