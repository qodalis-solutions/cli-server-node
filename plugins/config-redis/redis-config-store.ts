import Redis from 'ioredis';
import {
    CliConfigConflictError,
    applyCliConfigChanges,
    cloneCliConfigValue,
    type CliConfigSource,
    type CliConfigStoreDescription,
    type CliConfigStoredSection,
    type CliConfigValue,
    type ICliConfigStore,
} from '@qodalis/cli-server-abstractions';

/** The key prefix when none is given: `qcli:config:<provider>:<section>`. */
export const DEFAULT_REDIS_CONFIG_KEY_PREFIX = 'qcli:config:';

/**
 * The atomic write: sets the section's values and the next version only when the stored version
 * is still the one the change was computed from (`ARGV[1]`); answers `{1, newVersion}`, or
 * `{0, currentVersion}` when another write came first. `ARGV[2]` the values as JSON, `ARGV[3]`
 * the time (ISO 8601), `ARGV[4]` the TTL in seconds (0: none).
 */
export const REDIS_CONFIG_WRITE_SCRIPT = `
local current = tonumber(redis.call('HGET', KEYS[1], 'version') or '0') or 0
if current ~= tonumber(ARGV[1]) then
    return {0, current}
end
local nextVersion = current + 1
redis.call('HSET', KEYS[1], 'version', nextVersion, 'values', ARGV[2], 'updatedAt', ARGV[3])
local ttl = tonumber(ARGV[4]) or 0
if ttl > 0 then
    redis.call('EXPIRE', KEYS[1], ttl)
end
return {1, nextVersion}
`;

/** The Redis commands the store uses: an ioredis client fits (`new Redis(...)`). */
export interface CliRedisConfigClient {
    hgetall(key: string): Promise<Record<string, string>>;
    eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
    quit?(): Promise<unknown>;
    on?(event: 'error', listener: (err: Error) => void): unknown;
    /** Where it connects (ioredis' parsed options): shown by `describe()`, never the password. */
    readonly options?: { host?: string; port?: number; db?: number; path?: string };
}

/** Options of {@link CliRedisConfigStore}: a `client` or a `url`. */
export interface CliRedisConfigStoreOptions {
    /** A connected client (ioredis), shared with the app; the store never closes it. */
    client?: CliRedisConfigClient;
    /** A Redis URL (`redis://[:password@]host:6379/0`, `rediss://` for TLS): the store creates its client and `close()` ends it. */
    url?: string;
    /** Prepended to every key (default `qcli:config:`): `qcli:config:<provider>:<section>`. */
    keyPrefix?: string;
    /** Expire a section this many seconds after its last change (default none: kept until deleted). */
    ttlSeconds?: number;
    /** How often a write without an expected version is retried when another write came first (default 10). */
    maxRetries?: number;
}

/**
 * Keeps writable config settings in Redis (source `database`): one hash per provider section
 * (`qcli:config:<provider>:<section>`) with the fields `values` (JSON), `version` and
 * `updatedAt`. A write reads the section, applies the changes and stores them with a Lua script
 * that checks the version first, so servers sharing the Redis never lose a change: a stale
 * expected version is refused ({@link CliConfigConflictError}), a write without one is retried.
 *
 * Use it for every provider, or for some only, next to other stores:
 *
 * ```ts
 * const redisStore = new CliRedisConfigStore({ url: process.env.REDIS_URL });
 * createCliServer({ config: { store: new JsonFileConfigStore('config.json'), stores: { jobs: redisStore } } });
 * ```
 */
export class CliRedisConfigStore implements ICliConfigStore {
    readonly source: CliConfigSource = 'database';
    readonly client: CliRedisConfigClient;
    readonly keyPrefix: string;
    private readonly ttlSeconds: number;
    private readonly maxRetries: number;
    private readonly ownsClient: boolean;

    constructor(options: CliRedisConfigStoreOptions) {
        if (options.client) {
            this.client = options.client;
            this.ownsClient = false;
        } else if (options.url) {
            // Connects on the first command; errors surface on the commands, not as unhandled events
            const client = new Redis(options.url, { lazyConnect: true });
            client.on('error', () => undefined);
            this.client = client as unknown as CliRedisConfigClient;
            this.ownsClient = true;
        } else {
            throw new Error('CliRedisConfigStore needs a client or a url');
        }
        this.keyPrefix = options.keyPrefix ?? DEFAULT_REDIS_CONFIG_KEY_PREFIX;
        const ttl = options.ttlSeconds;
        if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 0)) throw new Error('ttlSeconds must be a whole number of seconds');
        this.ttlSeconds = ttl ?? 0;
        this.maxRetries = Math.max(0, options.maxRetries ?? 10);
    }

    /** `cache:6379/0, prefix qcli:config`: host, port, database and key prefix; never the password or user. */
    describe(): CliConfigStoreDescription {
        const o = this.client.options ?? {};
        const where = o.path ? o.path : `${o.host ?? 'localhost'}:${o.port ?? 6379}`;
        const prefix = this.keyPrefix.replace(/:+$/, '');
        return {
            kind: 'redis',
            title: 'Redis',
            detail: `${where}/${o.db ?? 0}${prefix ? `, prefix ${prefix}` : ''}`,
            persistent: true,
        };
    }

    /** The section's key: `<prefix><provider>:<section>`. */
    keyOf(provider: string, section: string): string {
        return `${this.keyPrefix}${provider}:${section}`;
    }

    async read(provider: string, section: string): Promise<CliConfigStoredSection> {
        return parseHash(await this.client.hgetall(this.keyOf(provider, section)));
    }

    async write(
        provider: string,
        section: string,
        changes: Record<string, CliConfigValue | null>,
        expectedVersion?: number,
    ): Promise<CliConfigStoredSection> {
        const key = this.keyOf(provider, section);
        for (let attempt = 0; ; attempt++) {
            const current = await this.read(provider, section);
            if (expectedVersion !== undefined && expectedVersion !== current.version) {
                throw new CliConfigConflictError(String(current.version));
            }
            const values = applyCliConfigChanges(current.values, changes);
            const reply = await this.client.eval(
                REDIS_CONFIG_WRITE_SCRIPT,
                1,
                key,
                current.version,
                JSON.stringify(values),
                new Date().toISOString(),
                this.ttlSeconds,
            );
            const [ok, version] = Array.isArray(reply) ? reply.map(Number) : [NaN, NaN];
            if (ok === 1) return { values: cloneCliConfigValue(values) as Record<string, CliConfigValue>, version };
            if (ok !== 0 || !Number.isFinite(version)) throw new Error(`unexpected reply from Redis: ${JSON.stringify(reply)}`);
            // Another write came first
            if (expectedVersion !== undefined) throw new CliConfigConflictError(String(version));
            if (attempt >= this.maxRetries) throw new Error(`config section ${provider}.${section}: too many concurrent writes`);
        }
    }

    /** Ends the client the store created from `url`; a client given to it is left open. */
    async close(): Promise<void> {
        if (this.ownsClient) await this.client.quit?.();
    }
}

/** A section from its hash: `{ values: {}, version: 0 }` when missing; unreadable values read as empty. */
function parseHash(hash: Record<string, string> | null | undefined): CliConfigStoredSection {
    if (!hash || Object.keys(hash).length === 0) return { values: {}, version: 0 };
    let values: Record<string, CliConfigValue> = {};
    try {
        const parsed = JSON.parse(hash.values ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed as Record<string, CliConfigValue>;
    } catch {
        values = {};
    }
    const version = Number(hash.version);
    return { values, version: Number.isInteger(version) && version >= 0 ? version : 0 };
}
