import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    CliConfigConflictError,
    type CliConfigProviderStorage,
    type CliConfigSource,
    type CliConfigStoreDescription,
    type CliConfigValue,
} from './config-types';
import { cloneCliConfigValue } from './config-validation';

/** A section's stored values (the settings changed from their defaults) and its version (0 when nothing is stored). */
export interface CliConfigStoredSection {
    values: Record<string, CliConfigValue>;
    version: number;
}

/**
 * Where writable settings are kept: the values changed from their defaults, per provider and
 * section, with a version per section that grows by one on every write. Shipped: in memory
 * ({@link InMemoryConfigStore}), a JSON file ({@link JsonFileConfigStore}) and a database
 * (`CliDatabaseConfigStore` of the databases plugin). Secrets are stored as given: keep the
 * file or table where only the server can read it.
 */
export interface ICliConfigStore {
    /** The `source` of the settings it holds: `runtime` (memory), `file` or `database`. */
    readonly source: CliConfigSource;
    /**
     * Where it keeps the settings, shown by `GET /config` (`store`), the dashboard's Config page
     * and `config list`: the file name or the database and table, never credentials. A store
     * without it is shown as a `custom` store ({@link describeCliConfigStore}).
     */
    describe?(): CliConfigStoreDescription;
    /** A section's values; `{ values: {}, version: 0 }` when nothing is stored. */
    read(provider: string, section: string): Promise<CliConfigStoredSection>;
    /**
     * Applies `changes` to a section atomically (`null` removes a key) and returns the section
     * as stored. With `expectedVersion`, throws {@link CliConfigConflictError} when the stored
     * version differs.
     */
    write(
        provider: string,
        section: string,
        changes: Record<string, CliConfigValue | null>,
        expectedVersion?: number,
    ): Promise<CliConfigStoredSection>;
}

/** The `storage` of a provider whose changes are kept in the config store. */
export const CLI_CONFIG_STORE_STORAGE: Readonly<CliConfigProviderStorage> = Object.freeze({
    kind: 'store',
    description: 'Changes are saved to the config store',
});

/** A store's description: its own `describe()`, else a `custom` store named after its class. */
export function describeCliConfigStore(store: ICliConfigStore): CliConfigStoreDescription {
    if (typeof store.describe === 'function') {
        const d = store.describe();
        return { kind: d.kind, title: d.title, detail: d.detail ?? '', persistent: d.persistent === true };
    }
    const name = (store as { constructor?: { name?: string } }).constructor?.name;
    return { kind: 'custom', title: 'Custom store', detail: name && name !== 'Object' ? name : '', persistent: store.source !== 'runtime' };
}

/** The store as one line: `JSON file (qcli-demo-config.json), kept across restarts`. */
export function describeCliConfigStoreLine(store: CliConfigStoreDescription): string {
    return `${store.title}${store.detail ? ` (${store.detail})` : ''}, ${store.persistent ? 'kept across restarts' : 'changes are lost on restart'}`;
}

/** A path relative to the working directory when inside it, else the file name only (no absolute paths in descriptions). */
function displayPath(filePath: string): string {
    const absolute = path.resolve(filePath);
    const relative = path.relative(process.cwd(), absolute);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
    return path.basename(absolute);
}

type StoredData = Record<string, Record<string, CliConfigStoredSection>>;

/** Applies changes to stored values: `null` removes the key. */
export function applyCliConfigChanges(
    values: Record<string, CliConfigValue>,
    changes: Record<string, CliConfigValue | null>,
): Record<string, CliConfigValue> {
    const next: Record<string, CliConfigValue> = { ...values };
    for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === undefined) delete next[key];
        else next[key] = cloneCliConfigValue(value);
    }
    return next;
}

/** Writes on stored data (shared by the memory and file stores). */
function writeSection(
    data: StoredData,
    provider: string,
    section: string,
    changes: Record<string, CliConfigValue | null>,
    expectedVersion: number | undefined,
): CliConfigStoredSection {
    const current = data[provider]?.[section] ?? { values: {}, version: 0 };
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw new CliConfigConflictError(String(current.version));
    }
    const next = { values: applyCliConfigChanges(current.values, changes), version: current.version + 1 };
    (data[provider] ??= {})[section] = next;
    return { values: cloneCliConfigValue(next.values) as Record<string, CliConfigValue>, version: next.version };
}

function readSection(data: StoredData, provider: string, section: string): CliConfigStoredSection {
    const current = data[provider]?.[section];
    return current
        ? { values: cloneCliConfigValue(current.values) as Record<string, CliConfigValue>, version: current.version }
        : { values: {}, version: 0 };
}

/** Keeps the settings in memory: changes apply at runtime and are lost on restart (source `runtime`). */
export class InMemoryConfigStore implements ICliConfigStore {
    readonly source: CliConfigSource = 'runtime';
    private readonly data: StoredData = {};

    describe(): CliConfigStoreDescription {
        return { kind: 'memory', title: 'In memory', detail: '', persistent: false };
    }

    async read(provider: string, section: string): Promise<CliConfigStoredSection> {
        return readSection(this.data, provider, section);
    }

    async write(
        provider: string,
        section: string,
        changes: Record<string, CliConfigValue | null>,
        expectedVersion?: number,
    ): Promise<CliConfigStoredSection> {
        return writeSection(this.data, provider, section, changes, expectedVersion);
    }
}

/**
 * Keeps the settings in a JSON file (source `file`), read once and rewritten on every change
 * (written to a temporary file, then renamed; mode 0600):
 *
 * ```json
 * { "custom": { "custom": { "version": 2, "values": { "motd": "hello" } } } }
 * ```
 *
 * Only this process writes the file: changes made to it while the server runs are overwritten.
 */
export class JsonFileConfigStore implements ICliConfigStore {
    readonly source: CliConfigSource = 'file';
    private data?: StoredData;

    constructor(readonly filePath: string) {}

    /** The file's path relative to the working directory, or its name when outside it. */
    describe(): CliConfigStoreDescription {
        return { kind: 'file', title: 'JSON file', detail: displayPath(this.filePath), persistent: true };
    }

    private load(): StoredData {
        if (this.data) return this.data;
        let parsed: unknown = {};
        if (fs.existsSync(this.filePath)) {
            const text = fs.readFileSync(this.filePath, 'utf8');
            try {
                parsed = text.trim() ? JSON.parse(text) : {};
            } catch (err) {
                throw new Error(`config file ${this.filePath} is not valid JSON: ${(err as Error).message}`);
            }
        }
        const data: StoredData = {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [provider, sections] of Object.entries(parsed as Record<string, unknown>)) {
                if (!sections || typeof sections !== 'object' || Array.isArray(sections)) continue;
                for (const [section, stored] of Object.entries(sections as Record<string, unknown>)) {
                    const s = stored as Partial<CliConfigStoredSection> | undefined;
                    if (!s || typeof s !== 'object') continue;
                    const values = s.values && typeof s.values === 'object' && !Array.isArray(s.values) ? s.values : {};
                    const version = typeof s.version === 'number' && Number.isInteger(s.version) && s.version >= 0 ? s.version : 0;
                    (data[provider] ??= {})[section] = { values: values as Record<string, CliConfigValue>, version };
                }
            }
        }
        this.data = data;
        return data;
    }

    private save(data: StoredData): void {
        fs.mkdirSync(path.dirname(path.resolve(this.filePath)), { recursive: true });
        const temp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temp, this.filePath);
    }

    async read(provider: string, section: string): Promise<CliConfigStoredSection> {
        return readSection(this.load(), provider, section);
    }

    async write(
        provider: string,
        section: string,
        changes: Record<string, CliConfigValue | null>,
        expectedVersion?: number,
    ): Promise<CliConfigStoredSection> {
        const data = this.load();
        const snapshot = JSON.stringify(data);
        const result = writeSection(data, provider, section, changes, expectedVersion);
        try {
            this.save(data);
        } catch (err) {
            // Not written: keep what is on disk
            this.data = JSON.parse(snapshot) as StoredData;
            throw err;
        }
        return result;
    }
}
