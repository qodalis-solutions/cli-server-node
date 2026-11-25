import {
    CLI_CONFIG_STORE_STORAGE,
    CliConfigConflictError,
    InMemoryConfigStore,
    describeCliConfigStore,
    cloneCliConfigValue,
    validateCliConfigValue,
    type CliConfigEntry,
    type CliConfigEntryType,
    type CliConfigErrors,
    type CliConfigProviderStorage,
    type CliConfigSection,
    type CliConfigStoredSection,
    type CliConfigUpdateResult,
    type CliConfigValidation,
    type CliConfigValue,
    type ICliConfigProvider,
    type ICliConfigStore,
    type ICliConfigWriter,
} from '@qodalis/cli-server-abstractions';

/** The config provider of the dashboard plugins' settings: one section per installed plugin with settings. */
export const DASHBOARD_PLUGINS_CONFIG_PROVIDER_ID = 'dashboard-plugins';
/** The most settings a dashboard plugin may declare. */
export const DASHBOARD_PLUGIN_CONFIG_MAX_ENTRIES = 50;
/** The most bytes a dashboard plugin's `config` may have as JSON. */
export const DASHBOARD_PLUGIN_CONFIG_MAX_BYTES = 32 * 1024;
/** A setting's key: a letter, then letters, digits, `_`, `.` and `-` (at most 64). */
export const DASHBOARD_PLUGIN_CONFIG_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/** The types a dashboard plugin's setting may have: every config entry type but `secret` (a plugin runs in the browser). */
export type DashboardPluginConfigEntryType = Exclude<CliConfigEntryType, 'secret'>;
export const DASHBOARD_PLUGIN_CONFIG_TYPES: readonly DashboardPluginConfigEntryType[] = ['string', 'number', 'boolean', 'string[]', 'enum', 'json', 'duration', 'url'];

/** A setting of a dashboard plugin (`qodalis.config.entries` of its package.json, `config.entries` of its version record). */
export interface DashboardPluginConfigEntry {
    key: string;
    label?: string;
    description?: string;
    type: DashboardPluginConfigEntryType;
    /** `null` when none. */
    default: CliConfigValue;
    validation?: CliConfigValidation;
}

/** A dashboard plugin's settings. */
export interface DashboardPluginConfig {
    entries: DashboardPluginConfigEntry[];
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function validRegex(pattern: string): boolean {
    try {
        new RegExp(pattern);
        return true;
    } catch {
        return false;
    }
}

/** A setting's validation rules, checked and copied (unknown rules dropped). Throws with the reason. */
function parseValidation(raw: unknown, key: string): CliConfigValidation | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!isObject(raw)) throw new Error(`${key}: validation must be an object`);
    const out: CliConfigValidation = {};
    for (const rule of ['min', 'max'] as const) {
        if (raw[rule] === undefined) continue;
        if (typeof raw[rule] !== 'number' || !Number.isFinite(raw[rule])) throw new Error(`${key}: validation.${rule} must be a number`);
        out[rule] = raw[rule] as number;
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) throw new Error(`${key}: validation.min is above validation.max`);
    if (raw.pattern !== undefined) {
        if (typeof raw.pattern !== 'string' || raw.pattern.length > 500 || !validRegex(raw.pattern)) throw new Error(`${key}: validation.pattern must be a regular expression`);
        out.pattern = raw.pattern;
    }
    if (raw.options !== undefined) {
        if (!Array.isArray(raw.options) || raw.options.length > 200 || raw.options.some((o) => typeof o !== 'string')) {
            throw new Error(`${key}: validation.options must be a list of strings`);
        }
        out.options = [...(raw.options as string[])];
    }
    if (raw.required !== undefined) {
        if (typeof raw.required !== 'boolean') throw new Error(`${key}: validation.required must be true or false`);
        out.required = raw.required;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A dashboard plugin's `config` as the marketplace publishes it (`{ entries: [...] }`), checked as strictly as the
 * marketplace does: at most 50 entries with unique keys (`^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`), the types of the config
 * providers but `secret` (a dashboard plugin runs in the browser: it cannot keep one), an `enum` with its options,
 * defaults that pass their own validation, at most 32 KB of JSON. Undefined for no settings (`undefined`, `null` or
 * no entries); throws with the reason for a bad one. Unknown fields are dropped.
 */
export function parseDashboardPluginConfig(raw: unknown): DashboardPluginConfig | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!isObject(raw)) throw new Error('config must be an object');
    let size: number;
    try {
        size = Buffer.byteLength(JSON.stringify(raw));
    } catch {
        throw new Error('config must be JSON');
    }
    if (size > DASHBOARD_PLUGIN_CONFIG_MAX_BYTES) throw new Error('config is larger than 32 KB');
    const rawEntries = raw.entries ?? [];
    if (!Array.isArray(rawEntries)) throw new Error('config.entries must be a list');
    if (rawEntries.length > DASHBOARD_PLUGIN_CONFIG_MAX_ENTRIES) throw new Error(`config has more than ${DASHBOARD_PLUGIN_CONFIG_MAX_ENTRIES} entries`);
    const keys = new Set<string>();
    const entries: DashboardPluginConfigEntry[] = [];
    for (const e of rawEntries as unknown[]) {
        if (!isObject(e)) throw new Error('every config entry must be an object');
        const key = e.key;
        if (typeof key !== 'string' || !DASHBOARD_PLUGIN_CONFIG_KEY.test(key)) throw new Error(`invalid config key: ${String(key)}`);
        if (keys.has(key)) throw new Error(`duplicate config key: ${key}`);
        keys.add(key);
        if (e.type === 'secret') throw new Error(`${key}: secret settings are not allowed (a dashboard plugin runs in the browser)`);
        if (typeof e.type !== 'string' || !DASHBOARD_PLUGIN_CONFIG_TYPES.includes(e.type as DashboardPluginConfigEntryType)) {
            throw new Error(`${key}: unknown type ${String(e.type)}`);
        }
        const type = e.type as DashboardPluginConfigEntryType;
        for (const field of ['label', 'description'] as const) {
            if (e[field] !== undefined && typeof e[field] !== 'string') throw new Error(`${key}: ${field} must be a string`);
        }
        const validation = parseValidation(e.validation, key);
        if (type === 'enum' && !validation?.options?.length) throw new Error(`${key}: an enum needs validation.options`);
        const entry: DashboardPluginConfigEntry = {
            key,
            ...(typeof e.label === 'string' ? { label: e.label } : {}),
            ...(typeof e.description === 'string' ? { description: e.description } : {}),
            type,
            default: cloneCliConfigValue((e.default ?? null) as CliConfigValue),
            ...(validation ? { validation } : {}),
        };
        const error = validateCliConfigValue({ type, validation, default: entry.default }, entry.default);
        if (error) throw new Error(`${key}: the default ${error}`);
        entries.push(entry);
    }
    return entries.length > 0 ? { entries } : undefined;
}

/**
 * Values given for a plugin's settings (`config` of an install or update): per-key errors, the config providers'
 * validation (`unknown setting`, the type and rules); empty when valid. `null` keeps a setting at its default.
 */
export function validateDashboardPluginConfigValues(config: DashboardPluginConfig | undefined, values: Record<string, unknown>): CliConfigErrors {
    const errors: CliConfigErrors = {};
    for (const [key, value] of Object.entries(values)) {
        const entry = config?.entries.find((e) => e.key === key);
        if (!entry) {
            errors[key] = 'unknown setting';
            continue;
        }
        const error = validateCliConfigValue(entry, value);
        if (error) errors[key] = error;
    }
    return errors;
}

interface PluginSection {
    id: string;
    title: string;
    description?: string;
    config: DashboardPluginConfig;
}

/**
 * `dashboard-plugins`: the settings of the dashboard plugins installed from the marketplace, one section per plugin
 * with settings (its page id, its title), the entries of the installed version with their defaults. Writable through
 * the config API, the `config` command and MCP like any provider (validation, versions, audit, `config:changed`).
 * Its store is resolved the usual way: the host's store for `dashboard-plugins`, else the server's default store.
 */
export class DashboardPluginsConfigProvider implements ICliConfigProvider, ICliConfigWriter {
    readonly id = DASHBOARD_PLUGINS_CONFIG_PROVIDER_ID;
    readonly title = 'Dashboard plugins';
    readonly description = 'Settings of the dashboard plugins installed from the marketplace';
    readonly order = 85;
    readonly storage: CliConfigProviderStorage = { ...CLI_CONFIG_STORE_STORAGE };
    private readonly sections = new Map<string, PluginSection>();
    private readonly cache = new Map<string, CliConfigStoredSection>();
    private _attached?: ICliConfigStore;
    private _fallback?: ICliConfigStore;

    /** The store the server attached; undefined before the provider is registered. */
    get store(): ICliConfigStore | undefined {
        return this._attached;
    }

    /** Called by the server when the provider is registered, with the store it resolved. */
    attachStore(store: ICliConfigStore): Promise<void> {
        this._attached = store;
        this.cache.clear();
        return Promise.resolve();
    }

    private ensureStore(): ICliConfigStore {
        return this._attached ?? (this._fallback ??= new InMemoryConfigStore());
    }

    private async stored(sectionId: string): Promise<CliConfigStoredSection> {
        const cached = this.cache.get(sectionId);
        if (cached) return cached;
        const stored = await this.ensureStore().read(this.id, sectionId);
        this.cache.set(sectionId, stored);
        return stored;
    }

    /** Adds or replaces a plugin's section. */
    setSection(id: string, title: string, config: DashboardPluginConfig, description?: string): void {
        this.sections.set(id, { id, title, config, ...(description ? { description } : {}) });
    }

    /** Removes a plugin's section (its stored values stay unless {@link clear}ed). */
    removeSection(id: string): void {
        this.sections.delete(id);
    }

    hasSection(id: string): boolean {
        return this.sections.has(id);
    }

    /** A plugin's settings, as its section declares them. */
    configOf(id: string): DashboardPluginConfig | undefined {
        return this.sections.get(id)?.config;
    }

    /** The values stored for a section (the settings changed from their defaults), whether it exists or not. */
    async storedValues(sectionId: string): Promise<Record<string, CliConfigValue>> {
        return cloneCliConfigValue((await this.stored(sectionId)).values) as Record<string, CliConfigValue>;
    }

    /** A section's effective values (stored over defaults) and its version; undefined for no section. */
    async values(sectionId: string): Promise<{ values: Record<string, CliConfigValue>; version: string } | undefined> {
        const section = this.sections.get(sectionId);
        if (!section) return undefined;
        const stored = await this.stored(sectionId);
        const values: Record<string, CliConfigValue> = {};
        for (const entry of section.config.entries) {
            values[entry.key] = cloneCliConfigValue(Object.prototype.hasOwnProperty.call(stored.values, entry.key) ? stored.values[entry.key] : entry.default);
        }
        return { values, version: String(stored.version) };
    }

    /** Writes changes to a section's stored values (`null` removes a key) without the config service's checks; the new version. */
    async write(sectionId: string, changes: Record<string, CliConfigValue | null>): Promise<string> {
        const stored = await this.ensureStore().write(this.id, sectionId, changes);
        this.cache.set(sectionId, stored);
        return String(stored.version);
    }

    /** Deletes every value stored for a section; the keys removed (none: nothing written). */
    async clear(sectionId: string): Promise<{ keys: string[]; version?: string }> {
        const keys = Object.keys((await this.stored(sectionId)).values);
        if (keys.length === 0) return { keys };
        const version = await this.write(sectionId, Object.fromEntries(keys.map((k) => [k, null])));
        return { keys, version };
    }

    /** The kind of the store its values are kept in (`memory`, `file`, ...), as `config:changed` carries it. */
    get storeKind(): string {
        return describeCliConfigStore(this.ensureStore()).kind;
    }

    async getSections(): Promise<CliConfigSection[]> {
        const result: CliConfigSection[] = [];
        for (const section of this.sections.values()) {
            const stored = await this.stored(section.id);
            const source = this.ensureStore().source;
            const entries: CliConfigEntry[] = section.config.entries.map((entry) => {
                const overridden = Object.prototype.hasOwnProperty.call(stored.values, entry.key);
                return {
                    key: entry.key,
                    ...(entry.label !== undefined ? { label: entry.label } : {}),
                    ...(entry.description !== undefined ? { description: entry.description } : {}),
                    type: entry.type,
                    value: cloneCliConfigValue(overridden ? stored.values[entry.key] : entry.default),
                    default: cloneCliConfigValue(entry.default),
                    source: overridden ? source : 'default',
                    mutable: true,
                    ...(entry.validation ? { validation: { ...entry.validation } } : {}),
                };
            });
            result.push({
                id: section.id,
                title: section.title,
                ...(section.description ? { description: section.description } : {}),
                entries,
                version: String(stored.version),
            });
        }
        return result;
    }

    validate(sectionId: string, changes: Record<string, CliConfigValue>): CliConfigErrors {
        const section = this.sections.get(sectionId);
        if (!section) return {};
        const errors: CliConfigErrors = {};
        for (const key of Object.keys(changes)) {
            if (!section.config.entries.some((e) => e.key === key)) errors[key] = 'unknown setting';
        }
        return errors;
    }

    async update(sectionId: string, changes: Record<string, CliConfigValue>, expectedVersion: string | undefined): Promise<CliConfigUpdateResult> {
        if (!this.sections.has(sectionId)) throw new Error(`unknown config section: ${this.id}.${sectionId}`);
        let expected: number | undefined;
        if (expectedVersion !== undefined) {
            expected = /^\d+$/.test(expectedVersion) ? Number(expectedVersion) : -1;
            if (expected < 0) throw new CliConfigConflictError(String((await this.stored(sectionId)).version));
        }
        const stored = await this.ensureStore().write(this.id, sectionId, changes, expected);
        this.cache.set(sectionId, stored);
        return { applied: Object.keys(changes), requiresRestart: false, version: String(stored.version) };
    }
}
