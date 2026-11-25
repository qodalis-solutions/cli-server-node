import {
    CLI_CONFIG_KEY,
    CliConfigConflictError,
    type CliConfigContext,
    type CliConfigEntry,
    type CliConfigEntryType,
    type CliConfigErrors,
    type CliConfigSection,
    type CliConfigSource,
    type CliConfigUpdateResult,
    type CliConfigValidation,
    type CliConfigValue,
    type ICliConfigProvider,
    type ICliConfigWriter,
} from './config-types';
import { InMemoryConfigStore, type CliConfigStoredSection, type ICliConfigStore } from './config-store';
import { cloneCliConfigValue, inferCliConfigEntryType } from './config-validation';

/** A setting of a {@link CliStoredConfigProvider}. */
export interface CliConfigSettingDefinition {
    key: string;
    label?: string;
    description?: string;
    type: CliConfigEntryType;
    /** The value when nothing is stored (what the host configured); `null` when none. */
    default?: CliConfigValue;
    /** Where `default` comes from (e.g. `environment` when the host read it from a variable); default `default`. */
    source?: CliConfigSource;
    /** Can be changed (default true). A read-only setting shows `value()` (or `default`). */
    mutable?: boolean;
    requiresRestart?: boolean;
    /** Never returned; every `secret` is sensitive. */
    sensitive?: boolean;
    validation?: CliConfigValidation;
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
}

/**
 * A provider of settings described in code, whose changes are kept in an
 * {@link ICliConfigStore}: the server attaches its store when the provider is registered
 * (`builder.setConfigStore`, in memory by default) and the stored values are applied then.
 * Built-in providers and plugins use it; a host can too:
 *
 * ```ts
 * builder.addConfigProvider(new CliStoredConfigProvider({
 *     id: 'billing', title: 'Billing',
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
    private readonly sections: CliConfigSectionDefinition[];
    private store?: ICliConfigStore;
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
    }

    /**
     * Uses `store` and applies the values stored there. Called by the server when the provider is
     * registered; without it the provider keeps its changes in memory.
     */
    attachStore(store: ICliConfigStore): Promise<void> {
        this.store = store;
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
        if (!this.store) {
            this.store = new InMemoryConfigStore();
        }
        return this.store;
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
                    mutable,
                    requiresRestart: setting.requiresRestart === true,
                    sensitive,
                    ...(setting.validation ? { validation: { ...setting.validation } } : {}),
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
 * The `custom` provider: one free key/value section (`custom`) on the server's config store,
 * for the host's own settings (today's admin `custom` section). Values are strings, numbers,
 * booleans, string lists or JSON.
 */
export function createCustomConfigProvider(options: { id?: string; title?: string; description?: string; order?: number } = {}): CliStoredConfigProvider {
    return new CliStoredConfigProvider({
        id: options.id ?? 'custom',
        title: options.title ?? 'Custom',
        description: options.description ?? 'Free settings of the host application, kept in the config store',
        order: options.order ?? 1000,
        sections: [{ id: 'custom', title: 'Custom settings', settings: [], allowCustomKeys: true }],
    });
}
