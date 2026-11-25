import { CLI_CONFIG_PROVIDER_ID, InMemoryConfigStore, type ICliConfigProvider, type ICliConfigStore } from '@qodalis/cli-server-abstractions';
import { createLogger } from '../utils/logger';

const logger = createLogger('Config');

/** Default `order` of a provider that sets none. */
export const DEFAULT_CONFIG_PROVIDER_ORDER = 100;

/** A provider that keeps its settings in a config store (e.g. a `CliStoredConfigProvider`), maybe its own. */
interface StoreAttachable {
    attachStore(store: ICliConfigStore): Promise<void>;
    /** The provider's own store, used unless the host set one for its id. */
    readonly ownStore?: ICliConfigStore;
}

function isStoreAttachable(provider: unknown): provider is StoreAttachable {
    return typeof (provider as Partial<StoreAttachable>)?.attachStore === 'function';
}

function isConfigStore(store: unknown): store is ICliConfigStore {
    const s = store as Partial<ICliConfigStore> | undefined;
    return !!s && typeof s.read === 'function' && typeof s.write === 'function';
}

/** A store's own `ready` (a promise, or a function returning one), when it has one. */
async function storeReady(store: ICliConfigStore): Promise<void> {
    const ready = store.ready;
    if (typeof ready === 'function') await ready.call(store);
    else if (ready && typeof (ready as Promise<void>).then === 'function') await ready;
}

/**
 * The config providers of a server (`builder.configProviders`) and the stores their writable
 * settings are kept in. Every provider that keeps settings in a store gets one, resolved in
 * this order: the host's store for its id (`builder.setConfigStore(store, id)`, `config.stores`),
 * the provider's own (`ownStore`), the default store (`builder.setConfigStore(store)`,
 * `config.store`), else in memory. A store may serve several providers. Started by
 * `createCliServer`: the providers registered so far get their store, every provider
 * registered later gets it when added, and the stored values are applied.
 */
export class CliConfigRegistry {
    private readonly _providers: ICliConfigProvider[] = [];
    private _defaultStore?: ICliConfigStore;
    private readonly _memoryStore = new InMemoryConfigStore();
    private readonly _stores = new Map<string, ICliConfigStore>();
    private readonly _attached = new Map<string, ICliConfigStore>();
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

    /** The store providers use unless the host set one for their id or they have their own (in memory unless set). */
    get defaultStore(): ICliConfigStore {
        return this._defaultStore ?? this._memoryStore;
    }

    /** The stores the host set per provider id (`setStore(store, id)`). */
    get providerStores(): ReadonlyMap<string, ICliConfigStore> {
        return this._stores;
    }

    /**
     * Keeps writable settings in `store`: of every provider without a store of its own
     * (the default store), or, with `providerId`, of that provider (whatever its own store).
     * The default store before the server starts the registry; a provider's before it is registered.
     */
    setStore(store: ICliConfigStore, providerId?: string): void {
        if (!isConfigStore(store)) throw new Error('invalid config store: it needs read and write');
        if (providerId === undefined) {
            if (this._started) throw new Error('the config store must be set before the server is created');
            this._defaultStore = store;
            return;
        }
        if (typeof providerId !== 'string' || !CLI_CONFIG_PROVIDER_ID.test(providerId)) throw new Error(`invalid config provider id: ${providerId}`);
        if (this._attached.has(providerId)) throw new Error(`the config store of ${providerId} must be set before the provider is registered`);
        this._stores.set(providerId, store);
    }

    /**
     * The store a provider's settings are kept in: the one it was given when registered, else
     * the one it would get now; undefined for a provider that keeps none (read-only, or saving itself).
     */
    storeOf(provider: ICliConfigProvider | string): ICliConfigStore | undefined {
        const p = typeof provider === 'string' ? this.find(provider) : provider;
        if (!p || !isStoreAttachable(p)) return undefined;
        return this._attached.get(p.id) ?? this.resolve(p);
    }

    /** The resolution order: the host's store for the id, the provider's own, the default store, memory. */
    private resolve(provider: ICliConfigProvider & StoreAttachable): ICliConfigStore {
        const own = provider.ownStore;
        return this._stores.get(provider.id) ?? (isConfigStore(own) ? own : undefined) ?? this.defaultStore;
    }

    /** Every store in use (each once), the default first. */
    get stores(): ICliConfigStore[] {
        const all = new Set<ICliConfigStore>([this.defaultStore]);
        for (const provider of this._providers) {
            const store = this.storeOf(provider);
            if (store) all.add(store);
        }
        return [...all];
    }

    /** Gives the providers their store (once); providers added later get theirs when added. */
    start(): void {
        if (this._started) return;
        this._started = true;
        for (const provider of this._providers) this.attach(provider);
    }

    get started(): boolean {
        return this._started;
    }

    /** Resolves when every provider has loaded and applied its stored settings, from every store; rejects with the first failure. */
    async ready(): Promise<void> {
        await Promise.all([...this.stores.map(storeReady), ...this._loading]);
    }

    private attach(provider: ICliConfigProvider): void {
        if (!isStoreAttachable(provider)) return;
        const store = this.resolve(provider);
        this._attached.set(provider.id, store);
        const loading = provider.attachStore(store);
        // Surfaced by ready() (and every config request); never an unhandled rejection
        loading.catch((err) => logger.error("Loading the settings of config provider '%s' failed: %s", provider.id, (err as Error)?.message ?? err));
        this._loading.push(loading);
    }
}
