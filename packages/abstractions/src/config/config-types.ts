/**
 * Config providers: the server's configuration, read and changed through providers that the
 * server, its plugins and the host application register. The same contract and JSON in the
 * Node, .NET and Python servers (cli-server-dashboard#61).
 */

/** The type of a setting; it decides the input the dashboard shows and how a value is validated. */
export type CliConfigEntryType = 'string' | 'number' | 'boolean' | 'string[]' | 'enum' | 'secret' | 'json' | 'duration' | 'url';

/** Every entry type, in the order of {@link CliConfigEntryType}. */
export const CLI_CONFIG_ENTRY_TYPES: readonly CliConfigEntryType[] = ['string', 'number', 'boolean', 'string[]', 'enum', 'secret', 'json', 'duration', 'url'];

/**
 * Where a setting's current value comes from: its `default`, a configuration `file`, an
 * `environment` variable, the `database`, or a change made at `runtime` (kept in memory).
 */
export type CliConfigSource = 'default' | 'file' | 'environment' | 'database' | 'runtime';

/** What kind of store keeps the writable settings: in `memory` (lost on restart), a JSON `file`, a `database`, or a `custom` store. */
export type CliConfigStoreKind = 'memory' | 'file' | 'database' | 'custom';

/**
 * Where changes are saved (`store` of `GET /api/v1/qcli/config`): what a store says about itself
 * (`ICliConfigStore.describe`). `detail` names the file (relative to the app) or the database and
 * table, never credentials or a connection string.
 */
export interface CliConfigStoreDescription {
    kind: CliConfigStoreKind;
    /** `In memory`, `JSON file`, `Database`, ... */
    title: string;
    /** `qcli-demo-config.json`, `PostgreSQL database qcli, table QcliConfig`; `''` when nothing to add. */
    detail: string;
    /** Changes are kept across restarts. */
    persistent: boolean;
}

/**
 * Where a provider's settings come from: `store` (changes are saved to the config store),
 * `runtime` (the running process), `options` (the options the server was created with),
 * `environment` (environment variables), `configuration` (the host's configuration, such as
 * .NET's IConfiguration) or `custom`.
 */
export type CliConfigStorageKind = 'store' | 'runtime' | 'options' | 'environment' | 'configuration' | 'custom';

/** Where a provider reads its settings from and saves changes to (`storage` of a provider view). */
export interface CliConfigProviderStorage {
    kind: CliConfigStorageKind;
    description: string;
    /** The origins in the order they apply (later ones override earlier ones): `Server options`, `appsettings.json`, ...; `[]` when none. */
    sources?: string[];
}

/** A setting's value: JSON (a `secret` is a string, a `duration` a string such as `30m`). */
export type CliConfigValue = string | number | boolean | string[] | null | unknown[] | { [key: string]: unknown };

/** Validation rules of a setting (checked by the server on every change). */
export interface CliConfigValidation {
    /** `number`/`duration` (milliseconds): the smallest value; `string`/`secret`/`url`: the shortest length; `string[]`: the fewest items. */
    min?: number;
    /** Same as `min`, the largest. */
    max?: number;
    /** A regular expression (JavaScript / .NET / Python compatible) the value must match; each item of a `string[]`. */
    pattern?: string;
    /** The allowed values of an `enum`, or of each item of a `string[]` / `string`. */
    options?: string[];
    /** The value may not be empty (`null`, `''` or `[]`). */
    required?: boolean;
}

/**
 * One setting, as a provider describes it. The server fills the defaults (`label` = `key`,
 * `description` = `''`, `source` = `default`, `mutable` / `requiresRestart` / `sensitive` = false)
 * and never returns the value or default of a `sensitive` entry (every `secret` is sensitive):
 * it answers `value: null` and `isSet`.
 */
export interface CliConfigEntry {
    key: string;
    label?: string;
    description?: string;
    type: CliConfigEntryType;
    /** The current value. Providers may leave a secret's value out and set `isSet` instead. */
    value?: CliConfigValue;
    /** The value the setting has when nothing sets it (`null` when none). */
    default?: CliConfigValue;
    source?: CliConfigSource;
    /** The setting can be changed (`PATCH`, `config set`, `config_set`). */
    mutable?: boolean;
    /** A change takes effect only after the server restarts. */
    requiresRestart?: boolean;
    /** The value is never returned (always true for a `secret`). */
    sensitive?: boolean;
    /** For a sensitive entry whose `value` the provider leaves out: whether one is set. */
    isSet?: boolean;
    validation?: CliConfigValidation;
    /** A hint for a richer input: `tags`, `cron`, `code`, `origins`, `textarea`, ... */
    editor?: string;
}

/** A group of settings of a provider, changed together (one version). */
export interface CliConfigSection {
    /** Unique within the provider: letters, digits, `_` and `-`. */
    id: string;
    title?: string;
    description?: string;
    entries: CliConfigEntry[];
    /** The section's version (an opaque string): a change made against an older one gets 409. Writable sections only. */
    version?: string;
    /** Keys not in `entries` may be added (and removed with `null`): a free key/value section such as `custom`. */
    allowCustomKeys?: boolean;
}

/** Who reads or changes the configuration, and what they may do. */
export interface CliConfigContext {
    /** The signed-in caller; undefined on a server without authentication. */
    caller?: { userId?: string; userName?: string; permissions?: readonly string[] };
    /** True when the caller holds the permission (always true on a server without authentication). */
    hasPermission(permission: string): boolean;
    /** Where the request comes from: the HTTP API, the terminal (`config` command) or MCP. */
    via?: 'api' | 'terminal' | 'mcp';
}

/**
 * A config provider: a named group of sections. Read-only unless it also implements
 * {@link ICliConfigWriter}. Registered with `builder.addConfigProvider(...)`, through a module's
 * `configProviders`, or by a plugin result's `configProviders` (`mountPlugin`).
 */
export interface ICliConfigProvider {
    /** Unique: lower-case letters, digits, `_` and `-` (`cors`, `my-app`). */
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    /** Sort order of the providers (ascending, then by id); default 100. */
    readonly order?: number;
    /** A permission needed, besides `config:read` / `config:write`, to see or change this provider. */
    readonly requiredPermission?: string;
    /**
     * Where its settings come from. Without it a writer is described as `custom` "Saved by the
     * provider", a read-only provider as `custom` "Read by the provider".
     */
    readonly storage?: CliConfigProviderStorage;
    getSections(context: CliConfigContext): CliConfigSection[] | Promise<CliConfigSection[]>;
}

/** Per-key errors: the key's message (`{ "maxAge": "must be at least 1m" }`). */
export type CliConfigErrors = Record<string, string>;

/** What a writer's `update` did. */
export interface CliConfigUpdateResult {
    /** The keys changed (or reset), in the order given. */
    applied: string[];
    /** True when one of them takes effect only after a restart. */
    requiresRestart: boolean;
    /** The section's new version. */
    version: string;
}

/**
 * The write side of a provider. The server checks the permissions, that each key exists and is
 * mutable, and its type and validation rules before calling `validate`, then `update`.
 * A `null` value resets the setting to its default (a secret: clears it).
 */
export interface ICliConfigWriter {
    /** Further checks (e.g. between keys); per-key errors, empty when valid. */
    validate(sectionId: string, changes: Record<string, CliConfigValue>, context: CliConfigContext): CliConfigErrors | Promise<CliConfigErrors>;
    /**
     * Applies the changes. Throws {@link CliConfigConflictError} when `expectedVersion` is given
     * and is not the section's current version, {@link CliConfigValidationError} for late errors.
     */
    update(
        sectionId: string,
        changes: Record<string, CliConfigValue>,
        expectedVersion: string | undefined,
        context: CliConfigContext,
    ): Promise<CliConfigUpdateResult>;
}

/** True for a provider that can also write ({@link ICliConfigWriter}). */
export function isCliConfigWriter(provider: unknown): provider is ICliConfigProvider & ICliConfigWriter {
    const p = provider as Partial<ICliConfigWriter> | undefined;
    return !!p && typeof p.validate === 'function' && typeof p.update === 'function';
}

/** The section changed since `expectedVersion` (HTTP 409). */
export class CliConfigConflictError extends Error {
    constructor(readonly currentVersion: string) {
        super('version conflict');
        this.name = 'CliConfigConflictError';
    }
}

/** Per-key validation errors found while updating (HTTP 400). */
export class CliConfigValidationError extends Error {
    constructor(readonly errors: CliConfigErrors) {
        super('validation failed');
        this.name = 'CliConfigValidationError';
    }
}

/** The permissions of config providers. */
export const CliConfigPermissions = {
    /** See the providers, their sections and settings (secrets stay hidden). */
    Read: 'config:read',
    /** Change settings. */
    Write: 'config:write',
} as const;

/** The event published after every change (audience `config:read`). */
export const CLI_CONFIG_CHANGED_EVENT = 'config:changed';

/** The audit event written for every change. */
export const CLI_CONFIG_AUDIT_EVENT = 'config.update';

/** How a masked secret appears in audit entries. */
export const CLI_CONFIG_SECRET_MASK = '***';

/** Provider ids: `cors`, `my-app`. */
export const CLI_CONFIG_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Section ids and setting keys: letters, digits, `_`, `-` and `.` (`allowedOrigins`, `rate.limit`). */
export const CLI_CONFIG_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

// ---------------------------------------------------------------- the JSON the server returns

/** An entry as the API returns it: every field present (`validation`, `editor`, `isSet` when relevant). */
export interface CliConfigEntryView {
    key: string;
    label: string;
    description: string;
    type: CliConfigEntryType;
    /** `null` for a sensitive entry. */
    value: CliConfigValue;
    /** `null` for a sensitive entry. */
    default: CliConfigValue;
    source: CliConfigSource;
    mutable: boolean;
    requiresRestart: boolean;
    sensitive: boolean;
    /** Sensitive entries only. */
    isSet?: boolean;
    validation?: CliConfigValidation;
    editor?: string;
}

/** A section as the API returns it. */
export interface CliConfigSectionView {
    id: string;
    title: string;
    description: string;
    /** True when an entry is mutable or keys may be added. */
    mutable: boolean;
    /** The version to send back with a change; `null` for a read-only section. */
    version: string | null;
    allowCustomKeys: boolean;
    entries: CliConfigEntryView[];
}

/** A provider as the API returns it (`GET /api/v1/qcli/config[/{provider}]`). */
export interface CliConfigProviderView {
    id: string;
    title: string;
    description: string;
    order: number;
    /** True when the provider implements the writer and the caller may change settings. */
    writable: boolean;
    /** Where its settings come from (`sources` always present). */
    storage: Required<CliConfigProviderStorage>;
    sections: CliConfigSectionView[];
}

/** The body of `GET /api/v1/qcli/config`: where changes are saved, and the providers. */
export interface CliConfigListView {
    store: CliConfigStoreDescription;
    providers: CliConfigProviderView[];
}

/** The body of `PATCH /api/v1/qcli/config/{provider}/{section}`. */
export interface CliConfigUpdateRequest {
    /** Key to new value; `null` resets to the default (clears a secret). */
    changes: Record<string, CliConfigValue>;
    /** The section's version the change is based on; a stale one gets 409. Optional: without it the change always applies. */
    version?: string;
}

/** The answer to a successful change. */
export interface CliConfigUpdateResponse extends CliConfigUpdateResult {
    provider: string;
    /** The section as it is now. */
    section: CliConfigSectionView;
}

/**
 * A refused read or change, as the API answers it: `status` is the HTTP status and the body is
 * `{ error, errors?, version? }` (`errors`: per-key messages on 400; `version`: the current
 * version on 409).
 */
export class CliConfigError extends Error {
    constructor(
        readonly status: 400 | 403 | 404 | 409,
        message: string,
        readonly errors?: CliConfigErrors,
        readonly version?: string,
    ) {
        super(message);
        this.name = 'CliConfigError';
    }

    toJSON(): { error: string; errors?: CliConfigErrors; version?: string } {
        return {
            error: this.message,
            ...(this.errors ? { errors: this.errors } : {}),
            ...(this.version !== undefined ? { version: this.version } : {}),
        };
    }
}

/** True for a {@link CliConfigError} (duck-typed: plugins may hold another copy of this package). */
export function isCliConfigError(err: unknown): err is CliConfigError {
    const e = err as Partial<CliConfigError> | undefined;
    return !!e && e.name === 'CliConfigError' && typeof e.status === 'number' && typeof e.toJSON === 'function';
}

/**
 * The server's configuration service (`builder.config` of the Node server): the providers,
 * filtered by permission, with secrets masked; changes validated, audited and published.
 * The admin plugin serves it over HTTP; the `config` command and the MCP tools use it too.
 */
export interface ICliConfigService {
    /** The providers the caller may see (`config:read` and each one's `requiredPermission`), sorted. Throws 403 without `config:read`. */
    list(context: CliConfigContext): Promise<CliConfigProviderView[]>;
    /** Where writable settings are saved (the config store's own description). */
    describeStore(): CliConfigStoreDescription;
    /** One provider. Throws {@link CliConfigError} 403 / 404. */
    get(providerId: string, context: CliConfigContext): Promise<CliConfigProviderView>;
    /** Changes a section. Throws {@link CliConfigError} 400 / 403 / 404 / 409. */
    update(providerId: string, sectionId: string, request: CliConfigUpdateRequest, context: CliConfigContext): Promise<CliConfigUpdateResponse>;
}

/**
 * `resource:action` permission matching: a `*` as the last segment matches that level and
 * everything below (`*`, `config:*`); a `*` elsewhere matches one segment. Case-insensitive.
 */
export function cliPermissionMatches(granted: string, required: string): boolean {
    const g = granted.trim().toLowerCase().split(':');
    const r = required.trim().toLowerCase().split(':');
    for (let i = 0; i < g.length; i++) {
        if (g[i] === '*' && i === g.length - 1) return true;
        if (i >= r.length || (g[i] !== '*' && g[i] !== r[i])) return false;
    }
    return g.length === r.length;
}

/** True when one of `granted` matches `required` ({@link cliPermissionMatches}). */
export function hasCliPermission(granted: readonly string[] | undefined, required: string): boolean {
    return !!granted?.some((p) => typeof p === 'string' && cliPermissionMatches(p, required));
}

/**
 * The context of a caller with these permissions; without a caller (a server without
 * authentication) every permission is granted.
 */
export function cliConfigContext(
    caller: { userId?: string; userName?: string; permissions?: readonly string[] } | undefined,
    via?: CliConfigContext['via'],
): CliConfigContext {
    return {
        ...(caller ? { caller } : {}),
        ...(via ? { via } : {}),
        hasPermission: (permission) => !caller || hasCliPermission(caller.permissions, permission),
    };
}
