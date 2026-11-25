import {
    CLI_CONFIG_KEY,
    CliConfigConflictError,
    type CliConfigContext,
    type CliConfigEntry,
    type CliConfigEntryType,
    type CliConfigErrors,
    type CliConfigOrigin,
    type CliConfigProviderStorage,
    type CliConfigSection,
    type CliConfigSource,
    type CliConfigUpdateResult,
    type CliConfigValidation,
    type CliConfigValue,
    type ICliConfigProvider,
    type ICliConfigWriter,
} from './config-types';
import { CLI_CONFIG_STORE_STORAGE, InMemoryConfigStore, type CliConfigStoredSection, type ICliConfigStore } from './config-store';
import { cloneCliConfigValue, inferCliConfigEntryType } from './config-validation';

/** A setting of a {@link CliStoredConfigProvider}. */
export interface CliConfigSettingDefinition {
    key: string;
    label?: string;
    description?: string;
    type: CliConfigEntryType;
    /** The value when nothing is stored (what the host configured); `null` when none. */
    default?: CliConfigValue;
    /**
     * Where `default` comes from (e.g. `environment` when the host read it from a variable, `code` for a plugin's code
     * options); default `default`. A stored value shows the store's source and origin `setting`.
     */
    source?: CliConfigSource;
    /** Can be changed (default true). A read-only setting shows `value()` (or `default`). */
    mutable?: boolean;
    requiresRestart?: boolean;
    /** Never returned; every `secret` is sensitive. */
    sensitive?: boolean;
    validation?: CliConfigValidation;
    /**
     * The plugin needs a value to run: without one (`null`, `''`, `[]`) it loads as `needs-configuration`
     * ({@link CliStoredConfigProvider.missingRequired}). Unlike `validation.required`, the value may still be reset.
     */
    required?: boolean;
    editor?: string;
    /** The live value of a read-only setting (read on every `getSections`). */
    value?: () => CliConfigValue;
    /** A further rule on a new value (after the type and `validation`); the message, or undefined. */
    validate?(value: CliConfigValue): string | undefined;
    /**
     * Makes the effective value take effect (the stored value, or `default` after a reset):
     * called for every stored value when the store is attached, and after every change.
     */
    apply?(value: CliConfigValue): void;
}

/** A section of a {@link CliStoredConfigProvider}. */
export interface CliConfigSectionDefinition {
    id: string;
    title?: string;
    description?: string;
    settings: CliConfigSettingDefinition[];
    /** Keys not in `settings` may be added and removed (`null`): a free key/value section. */
    allowCustomKeys?: boolean;
}

export interface CliStoredConfigProviderOptions {
    id: string;
    title: string;
    description?: string;
    order?: number;
    requiredPermission?: string;
    sections: CliConfigSectionDefinition[];
    /**
     * The store this provider's changes are kept in. The host's store for this id
     * (`config.stores`, `builder.setConfigStore(store, id)`) still wins; without either the
     * server's default store is used (in memory unless the host sets one).
     */
    store?: ICliConfigStore;
}

/**
 * A provider of settings described in code, whose changes are kept in an
 * {@link ICliConfigStore}: the server attaches a store when the provider is registered and the
 * stored values are applied then. Which store: the host's store for this provider's id
 * (`config.stores`, `builder.setConfigStore(store, id)`), else the provider's own (`store`
 * option, {@link setStore}), else the server's default store (`builder.setConfigStore(store)`),
 * else in memory. Built-in providers and plugins use it; a host can too:
 *
 * ```ts
 * builder.addConfigProvider(new CliStoredConfigProvider({
 *     id: 'billing', title: 'Billing',
 *     store: new JsonFileConfigStore('config/app.json', { section: 'qcli' }),
 *     sections: [{ id: 'invoices', settings: [
 *         { key: 'dueDays', type: 'number', default: 30, validation: { min: 1, max: 90 }, apply: (v) => (billing.dueDays = v as number) },
 *         { key: 'apiKey', type: 'secret' },
 *     ] }],
 * }));
 * ```
 */
export class CliStoredConfigProvider implements ICliConfigProvider, ICliConfigWriter {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly order?: number;
    readonly requiredPermission?: string;
    /** Changes are saved to the config store. */
    readonly storage: CliConfigProviderStorage = { ...CLI_CONFIG_STORE_STORAGE };
    private readonly sections: CliConfigSectionDefinition[];
    private _ownStore?: ICliConfigStore;
    private _attached?: ICliConfigStore;
    private _fallback?: ICliConfigStore;
    private readonly cache = new Map<string, CliConfigStoredSection>();
    private loading?: Promise<void>;

    constructor(options: CliStoredConfigProviderOptions) {
        this.id = options.id;
        this.title = options.title;
        this.description = options.description;
        this.order = options.order;
        this.requiredPermission = options.requiredPermission;
        const ids = new Set<string>();
        for (const section of options.sections) {
            if (!CLI_CONFIG_KEY.test(section.id) || ids.has(section.id)) throw new Error(`invalid or duplicate config section: ${section.id}`);
            ids.add(section.id);
            const keys = new Set<string>();
            for (const setting of section.settings) {
                if (!CLI_CONFIG_KEY.test(setting.key) || keys.has(setting.key)) {
                    throw new Error(`invalid or duplicate config key: ${section.id}.${setting.key}`);
                }
                keys.add(setting.key);
            }
        }
        this.sections = options.sections;
        this._ownStore = options.store;
    }

    /** The provider's own store (the `store` option or {@link setStore}); the host's store for this id still wins. */
    get ownStore(): ICliConfigStore | undefined {
        return this._ownStore;
    }

    /** The store its changes are kept in: the one the server attached, else its own; undefined before either. */
    get store(): ICliConfigStore | undefined {
        return this._attached ?? this._ownStore;
    }

    /** Sets the provider's own store (as the `store` option); before the provider is registered. */
    setStore(store: ICliConfigStore | undefined): this {
        if (this._attached) throw new Error(`the config store of ${this.id} must be set before the provider is registered`);
        this._ownStore = store;
        return this;
    }

    /**
     * Uses `store` and applies the values stored there. Called by the server when the provider is
     * registered, with the store it resolved; without it the provider uses its own store, else memory.
     */
    attachStore(store: ICliConfigStore): Promise<void> {
        this._attached = store;
        this.cache.clear();
        this.loading = (async () => {
            for (const section of this.sections) {
                const stored = await store.read(this.id, section.id);
                this.cache.set(section.id, stored);
                for (const setting of section.settings) {
                    if (setting.mutable !== false && Object.prototype.hasOwnProperty.call(stored.values, setting.key)) {
                        setting.apply?.(cloneCliConfigValue(stored.values[setting.key]));
                    }
                }
            }
        })();
        return this.loading;
    }

    /** Resolves once the stored values are loaded and applied. */
    ready(): Promise<void> {
        return this.loading ?? Promise.resolve();
    }

    private ensureStore(): ICliConfigStore {
        return this._attached ?? this._ownStore ?? (this._fallback ??= new InMemoryConfigStore());
    }

    private async stored(sectionId: string): Promise<CliConfigStoredSection> {
        await this.loading;
        const cached = this.cache.get(sectionId);
        if (cached) return cached;
        const stored = await this.ensureStore().read(this.id, sectionId);
        this.cache.set(sectionId, stored);
        return stored;
    }

    private section(sectionId: string): CliConfigSectionDefinition | undefined {
        return this.sections.find((s) => s.id === sectionId);
    }

    /**
     * A setting's effective value: the stored one, else its default (or the live value of a
     * read-only setting). Secrets included: for the host's own code, never for clients.
     */
    value(sectionId: string, key: string): CliConfigValue | undefined {
        const section = this.section(sectionId);
        const setting = section?.settings.find((s) => s.key === key);
        const stored = this.cache.get(sectionId)?.values;
        if (setting) {
            if (setting.mutable === false) return setting.value ? setting.value() : (setting.default ?? null);
            if (stored && Object.prototype.hasOwnProperty.call(stored, key)) return cloneCliConfigValue(stored[key]);
            return cloneCliConfigValue(setting.default ?? null);
        }
        if (section?.allowCustomKeys && stored && Object.prototype.hasOwnProperty.call(stored, key)) return cloneCliConfigValue(stored[key]);
        return undefined;
    }

    /**
     * Who decided a setting's effective value: `setting` (stored), `code` (its default comes from the host's code or
     * environment), else `default`; undefined for an unknown key.
     */
    origin(sectionId: string, key: string): CliConfigOrigin | undefined {
        const section = this.section(sectionId);
        const setting = section?.settings.find((s) => s.key === key);
        const stored = this.cache.get(sectionId)?.values;
        const isStored = !!stored && Object.prototype.hasOwnProperty.call(stored, key);
        if (!setting) return section?.allowCustomKeys && isStored ? 'setting' : undefined;
        if (setting.mutable !== false && isStored) return 'setting';
        return setting.source === 'code' || setting.source === 'environment' ? 'code' : 'default';
    }

    /**
     * The settings marked `required` (or `validation.required`) whose effective value is empty (`null`, `''` or `[]`), as
     * `<section>.<key>`: what a plugin needs before it can run (its state `needs-configuration`).
     */
    missingRequired(): string[] {
        const missing: string[] = [];
        for (const section of this.sections) {
            for (const setting of section.settings) {
                if (setting.required !== true && setting.validation?.required !== true) continue;
                const value = this.value(section.id, setting.key);
                const empty = value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);
                if (empty) missing.push(`${section.id}.${setting.key}`);
            }
        }
        return missing;
    }

    async getSections(_context?: CliConfigContext): Promise<CliConfigSection[]> {
        const result: CliConfigSection[] = [];
        for (const section of this.sections) {
            const stored = await this.stored(section.id);
            const source = this.ensureStore().source;
            const entries: CliConfigEntry[] = section.settings.map((setting) => {
                const mutable = setting.mutable !== false;
                const overridden = mutable && Object.prototype.hasOwnProperty.call(stored.values, setting.key);
                const value = !mutable && setting.value ? setting.value() : overridden ? stored.values[setting.key] : (setting.default ?? null);
                const sensitive = setting.sensitive === true || setting.type === 'secret';
                return {
                    key: setting.key,
                    ...(setting.label !== undefined ? { label: setting.label } : {}),
                    ...(setting.description !== undefined ? { description: setting.description } : {}),
                    type: setting.type,
                    ...(sensitive
                        ? { value: null, default: null, isSet: value !== null && value !== undefined && value !== '' }
                        : { value: cloneCliConfigValue(value), default: cloneCliConfigValue(setting.default ?? null) }),
                    source: overridden ? source : (setting.source ?? 'default'),
                    origin: overridden ? ('setting' as const) : setting.source === 'code' || setting.source === 'environment' ? ('code' as const) : ('default' as const),
                    mutable,
                    requiresRestart: setting.requiresRestart === true,
                    sensitive,
                    ...(setting.validation ? { validation: { ...setting.validation } } : {}),
                    ...(setting.required ? { required: true } : {}),
                    ...(setting.editor ? { editor: setting.editor } : {}),
                };
            });
            if (section.allowCustomKeys) {
                const known = new Set(section.settings.map((s) => s.key));
                for (const [key, value] of Object.entries(stored.values)) {
                    if (known.has(key)) continue;
                    entries.push({
                        key,
                        type: inferCliConfigEntryType(value),
                        value: cloneCliConfigValue(value),
                        default: null,
                        source,
                        origin: 'setting',
                        mutable: true,
                    });
                }
            }
            const writable = section.allowCustomKeys === true || section.settings.some((s) => s.mutable !== false);
            result.push({
                id: section.id,
                ...(section.title !== undefined ? { title: section.title } : {}),
                ...(section.description !== undefined ? { description: section.description } : {}),
                entries,
                ...(writable ? { version: String(stored.version) } : {}),
                ...(section.allowCustomKeys ? { allowCustomKeys: true } : {}),
            });
        }
        return result;
    }

    validate(sectionId: string, changes: Record<string, CliConfigValue>): CliConfigErrors {
        const errors: CliConfigErrors = {};
        const section = this.section(sectionId);
        if (!section) return errors;
        for (const [key, value] of Object.entries(changes)) {
            const setting = section.settings.find((s) => s.key === key);
            if (!setting) {
                if (!section.allowCustomKeys) errors[key] = 'unknown setting';
                else if (!CLI_CONFIG_KEY.test(key)) errors[key] = 'invalid key: use letters, digits, _, - and .';
                continue;
            }
            if (setting.mutable === false) {
                errors[key] = 'read-only';
                continue;
            }
            if (value !== null && setting.validate) {
                const error = setting.validate(value);
                if (error) errors[key] = error;
            }
        }
        return errors;
    }

    async update(sectionId: string, changes: Record<string, CliConfigValue>, expectedVersion: string | undefined): Promise<CliConfigUpdateResult> {
        const section = this.section(sectionId);
        if (!section) throw new Error(`unknown config section: ${this.id}.${sectionId}`);
        await this.loading;
        let expected: number | undefined;
        if (expectedVersion !== undefined) {
            expected = /^\d+$/.test(expectedVersion) ? Number(expectedVersion) : -1;
            if (expected < 0) throw new CliConfigConflictError(String((await this.stored(sectionId)).version));
        }
        const stored = await this.ensureStore().write(this.id, sectionId, changes, expected);
        this.cache.set(sectionId, stored);
        const applied = Object.keys(changes);
        let requiresRestart = false;
        for (const key of applied) {
            const setting = section.settings.find((s) => s.key === key);
            if (!setting) continue;
            if (setting.requiresRestart) requiresRestart = true;
            setting.apply?.(this.value(sectionId, key) ?? null);
        }
        return { applied, requiresRestart, version: String(stored.version) };
    }
}

/**
 * The `custom` provider: one free key/value section (`custom`) for the host's own settings
 * (today's admin `custom` section), in its own `store` or the server's default one. Values are
 * strings, numbers, booleans, string lists or JSON.
 */
export function createCustomConfigProvider(
    options: { id?: string; title?: string; description?: string; order?: number; store?: ICliConfigStore } = {},
): CliStoredConfigProvider {
    return new CliStoredConfigProvider({
        id: options.id ?? 'custom',
        title: options.title ?? 'Custom',
        description: options.description ?? 'Free settings of the host application, kept in the config store',
        order: options.order ?? 1000,
        ...(options.store ? { store: options.store } : {}),
        sections: [{ id: 'custom', title: 'Custom settings', settings: [], allowCustomKeys: true }],
    });
}
