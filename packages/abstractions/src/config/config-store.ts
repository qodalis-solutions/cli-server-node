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
 * section, with a version per section that grows by one on every write. Every provider may have
 * its own store, and one store may serve several providers (its data is keyed by provider and
 * section). Shipped: in memory ({@link InMemoryConfigStore}), a JSON file or a section of the
 * app's JSON settings file ({@link JsonFileConfigStore}), a database (`CliDatabaseConfigStore`
 * of the databases plugin) and Redis (`CliRedisConfigStore`, `@qodalis/cli-server-plugin-config-redis`).
 * Secrets are stored as given: keep the file, table or keys where only the server can read them.
 */
export interface ICliConfigStore {
    /** The `source` of the settings it holds: `runtime` (memory), `file` or `database` (Redis too). */
    readonly source: CliConfigSource;
    /**
     * Where it keeps the settings, shown by `GET /config` (each stored provider's `store`, and
     * `defaultStore`), the dashboard's Config page and `config list`: the file name, the database
     * and table or the Redis host, never credentials. A store without it is shown as a `custom`
     * store ({@link describeCliConfigStore}).
     */
    describe?(): CliConfigStoreDescription;
    /**
     * Resolves once the store can be used (e.g. its table exists): `server.config.ready()` waits
     * for it, besides every provider's stored values. Optional.
     */
    readonly ready?: Promise<void> | (() => Promise<void>);
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

/** The `storage` of a provider whose changes are kept in a config store (the provider view's `store` says which). */
export const CLI_CONFIG_STORE_STORAGE: Readonly<CliConfigProviderStorage> = Object.freeze({
    kind: 'store',
    description: 'Changes are saved to its config store',
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
    return `${describeCliConfigStoreName(store)}, ${store.persistent ? 'kept across restarts' : 'changes are lost on restart'}`;
}

/** The store's title and detail: `Redis (cache:6379/0, prefix qcli:config)`, `In memory`. */
export function describeCliConfigStoreName(store: CliConfigStoreDescription): string {
    return `${store.title}${store.detail ? ` (${store.detail})` : ''}`;
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

/** Options of {@link JsonFileConfigStore}. */
export interface JsonFileConfigStoreOptions {
    /**
     * Keep the settings in this section of an existing JSON settings file (the app's own, like
     * .NET's appsettings.json) instead of the whole file: `qcli`, or a nested one as `app.qcli` or
     * `app:qcli`. The rest of the file is kept as it is (re-read on every write); the section is
     * created when missing.
     */
    section?: string;
}

/** A JSON object (not an array or null). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Stored data from parsed JSON: malformed sections and versions are skipped. */
function parseStoredData(parsed: unknown): StoredData {
    const data: StoredData = {};
    if (!isJsonObject(parsed)) return data;
    for (const [provider, sections] of Object.entries(parsed)) {
        if (!isJsonObject(sections)) continue;
        for (const [section, stored] of Object.entries(sections)) {
            const s = stored as Partial<CliConfigStoredSection> | undefined;
            if (!s || typeof s !== 'object') continue;
            const values = isJsonObject(s.values) ? s.values : {};
            const version = typeof s.version === 'number' && Number.isInteger(s.version) && s.version >= 0 ? s.version : 0;
            (data[provider] ??= {})[section] = { values: values as Record<string, CliConfigValue>, version };
        }
    }
    return data;
}

/**
 * Keeps the settings in a JSON file (source `file`), read once and rewritten on every change
 * (written to a temporary file, then renamed):
 *
 * ```json
 * { "custom": { "custom": { "version": 2, "values": { "motd": "hello" } } } }
 * ```
 *
 * The whole file by default (created with mode 0600; only this process writes it: changes made to
 * it while the server runs are overwritten). With `section`, one section of the app's own
 * settings file: `new JsonFileConfigStore('config/app.json', { section: 'qcli' })` keeps the
 * settings under `"qcli"`, re-reads the file on every write and leaves everything else in it
 * (keys, order, indentation, the file's mode) as it was.
 */
export class JsonFileConfigStore implements ICliConfigStore {
    readonly source: CliConfigSource = 'file';
    /** The section's path in the file (`['app', 'qcli']`); empty for the whole file. */
    readonly sectionPath: readonly string[];
    private data?: StoredData;

    constructor(
        readonly filePath: string,
        options: JsonFileConfigStoreOptions = {},
    ) {
        const section = options.section?.trim() ?? '';
        this.sectionPath = section ? section.split(/[.:]/) : [];
        if (this.sectionPath.some((part) => !part)) throw new Error(`invalid config file section: ${options.section}`);
    }

    /** The file's path relative to the working directory, or its name when outside it; and the section (`config/app.json, section qcli`). */
    describe(): CliConfigStoreDescription {
        const section = this.sectionPath.length ? `, section ${this.sectionPath.join('.')}` : '';
        return { kind: 'file', title: 'JSON file', detail: `${displayPath(this.filePath)}${section}`, persistent: true };
    }

    /** The whole file parsed, or `{}` when missing or empty. */
    private readFile(): { root: unknown; text: string } {
        if (!fs.existsSync(this.filePath)) return { root: {}, text: '' };
        const text = fs.readFileSync(this.filePath, 'utf8');
        try {
            return { root: text.trim() ? JSON.parse(text) : {}, text };
        } catch (err) {
            throw new Error(`config file ${this.filePath} is not valid JSON: ${(err as Error).message}`);
        }
    }

    /** The section's value in the parsed file (undefined when missing); throws when a part of the path is not an object. */
    private sectionOf(root: unknown): unknown {
        let node: unknown = root;
        for (let i = 0; i < this.sectionPath.length; i++) {
            if (!isJsonObject(node)) throw new Error(`config file ${this.filePath}: ${this.sectionPath.slice(0, i).join('.') || 'the file'} is not an object`);
            node = node[this.sectionPath[i]];
            if (node === undefined) return undefined;
        }
        if (node !== undefined && !isJsonObject(node)) throw new Error(`config file ${this.filePath}: ${this.sectionPath.join('.') || 'the file'} is not an object`);
        return node;
    }

    private load(): StoredData {
        if (this.data) return this.data;
        const { root } = this.readFile();
        this.data = parseStoredData(this.sectionPath.length ? this.sectionOf(root) : root);
        return this.data;
    }

    private save(data: StoredData): void {
        const target = path.resolve(this.filePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let text: string;
        let mode = 0o600;
        if (this.sectionPath.length) {
            // The rest of the file as it is now: re-read it, replace the section only
            const current = this.readFile();
            const root = isJsonObject(current.root) ? current.root : {};
            this.sectionOf(root);
            let node = root;
            for (const part of this.sectionPath.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
            node[this.sectionPath[this.sectionPath.length - 1]] = data;
            const indent = /^([ \t]+)\S/m.exec(current.text)?.[1] ?? '  ';
            text = `${JSON.stringify(root, null, indent)}${current.text && !current.text.endsWith('\n') ? '' : '\n'}`;
            if (fs.existsSync(target)) mode = fs.statSync(target).mode & 0o777;
        } else {
            text = `${JSON.stringify(data, null, 2)}\n`;
        }
        const temp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temp, text, { encoding: 'utf8', mode });
        fs.chmodSync(temp, mode);
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
            try {
                fs.rmSync(`${this.filePath}.${process.pid}.tmp`, { force: true });
            } catch {
                // nothing to remove
            }
            throw err;
        }
        return result;
    }
}
