import { CLI_CONFIG_PROVIDER_ID, InMemoryConfigStore, type ICliConfigProvider, type ICliConfigStore } from '@qodalis/cli-server-abstractions';
import { createLogger } from '../utils/logger';

const logger = createLogger('Config');

/** Default `order` of a provider that sets none. */
export const DEFAULT_CONFIG_PROVIDER_ORDER = 100;

/** A provider that keeps its settings in the server's store (e.g. a `CliStoredConfigProvider`). */
interface StoreAttachable {
    attachStore(store: ICliConfigStore): Promise<void>;
}

function isStoreAttachable(provider: unknown): provider is StoreAttachable {
    return typeof (provider as Partial<StoreAttachable>)?.attachStore === 'function';
}

/**
 * The config providers of a server (`builder.configProviders`) and the store their writable
 * settings are kept in (`builder.setConfigStore`, in memory by default). Started by
 * `createCliServer`: the store is attached to the providers registered so far, and to every
 * provider registered later, and the stored values are applied.
 */
export class CliConfigRegistry {
    private readonly _providers: ICliConfigProvider[] = [];
    private _store: ICliConfigStore = new InMemoryConfigStore();
    private _started = false;
    private readonly _loading: Promise<void>[] = [];

    /** Registers a provider. Throws `invalid config provider: <id>` or `config provider already registered: <id>`. */
    add(provider: ICliConfigProvider): void {
        if (!provider || typeof provider.id !== 'string' || !CLI_CONFIG_PROVIDER_ID.test(provider.id) || typeof provider.getSections !== 'function') {
            throw new Error(`invalid config provider: ${(provider as { id?: unknown })?.id}`);
        }
        if (typeof provider.title !== 'string' || !provider.title.trim()) {
            throw new Error(`invalid config provider: ${provider.id} needs a title`);
        }
        if (this.has(provider.id)) {
            throw new Error(`config provider already registered: ${provider.id}`);
        }
        this._providers.push(provider);
        if (this._started) this.attach(provider);
    }

    /** True when a provider with this id is registered. */
    has(id: string): boolean {
        return this._providers.some((p) => p.id === id);
    }

    find(id: string): ICliConfigProvider | undefined {
        return this._providers.find((p) => p.id === id);
    }

    /** The providers sorted by `order` (default 100), then id. */
    get providers(): ICliConfigProvider[] {
        return [...this._providers].sort(
            (a, b) => (a.order ?? DEFAULT_CONFIG_PROVIDER_ORDER) - (b.order ?? DEFAULT_CONFIG_PROVIDER_ORDER) || a.id.localeCompare(b.id),
        );
    }

    /** The store of writable settings. */
    get store(): ICliConfigStore {
        return this._store;
    }

    /** Keeps writable settings in `store`; only before the server starts the registry. */
    setStore(store: ICliConfigStore): void {
        if (this._started) throw new Error('the config store must be set before the server is created');
        this._store = store;
    }

    /** Attaches the store to the providers (once); providers added later are attached when added. */
    start(): void {
        if (this._started) return;
        this._started = true;
        for (const provider of this._providers) this.attach(provider);
    }

    get started(): boolean {
        return this._started;
    }

    /** Resolves when every provider has loaded and applied its stored settings; rejects with the first failure. */
    async ready(): Promise<void> {
        await Promise.all(this._loading);
    }

    private attach(provider: ICliConfigProvider): void {
        if (!isStoreAttachable(provider)) return;
        const loading = provider.attachStore(this._store);
        // Surfaced by ready() (and every config request); never an unhandled rejection
        loading.catch((err) => logger.error("Loading the settings of config provider '%s' failed: %s", provider.id, (err as Error)?.message ?? err));
        this._loading.push(loading);
    }
}
