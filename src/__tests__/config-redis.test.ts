/**
 * CliRedisConfigStore (@qodalis/cli-server-plugin-config-redis): the store contract on a fake
 * Redis (HGETALL and the write script's EVAL), keys and hashes, the atomic version check under
 * concurrent writers, TTL, describe() without credentials, and per-provider use in a server.
 * With QCLI_TEST_REDIS (a redis:// URL) the contract also runs against a real Redis.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import {
    CliConfigConflictError,
    CliStoredConfigProvider,
    InMemoryConfigStore,
    describeCliConfigStoreLine,
} from '@qodalis/cli-server-abstractions';
import {
    CliRedisConfigStore,
    DEFAULT_REDIS_CONFIG_KEY_PREFIX,
    REDIS_CONFIG_WRITE_SCRIPT,
    configRedisInstalledPlugin,
    type CliRedisConfigClient,
} from '@qodalis/cli-server-plugin-config-redis';
import { createCliServer } from '../create-cli-server';
import { storeContract } from './config-store-contract';

/**
 * The commands the store uses, in memory: HGETALL, and EVAL of the write script (checked to be
 * that script) with its compare-and-set semantics. `beforeEval` runs before each script, to
 * let a test write in between (another server).
 */
class FakeRedis implements CliRedisConfigClient {
    readonly hashes = new Map<string, Map<string, string>>();
    readonly ttls = new Map<string, number>();
    readonly calls: string[] = [];
    beforeEval?: () => Promise<void> | void;
    quitCalled = false;

    constructor(readonly options: { host?: string; port?: number; db?: number; path?: string } = { host: 'cache', port: 6379, db: 0 }) {}

    async hgetall(key: string): Promise<Record<string, string>> {
        this.calls.push(`HGETALL ${key}`);
        return Object.fromEntries(this.hashes.get(key) ?? []);
    }

    async eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
        expect(script).toBe(REDIS_CONFIG_WRITE_SCRIPT);
        expect(numberOfKeys).toBe(1);
        const hook = this.beforeEval;
        this.beforeEval = undefined;
        await hook?.();
        const [key, expected, values, updatedAt, ttl] = args.map(String);
        this.calls.push(`EVAL ${key} ${expected}`);
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        const current = Number(hash.get('version') ?? '0');
        if (current !== Number(expected)) return [0, current];
        const next = current + 1;
        hash.set('version', String(next));
        hash.set('values', values);
        hash.set('updatedAt', updatedAt);
        this.hashes.set(key, hash);
        if (Number(ttl) > 0) this.ttls.set(key, Number(ttl));
        return [1, next];
    }

    async quit(): Promise<string> {
        this.quitCalled = true;
        return 'OK';
    }
}

storeContract('CliRedisConfigStore (fake Redis)', async () => new CliRedisConfigStore({ client: new FakeRedis() }));

describe('CliRedisConfigStore', () => {
    it('one hash per provider section under the key prefix: values as JSON, version, updatedAt', async () => {
        const redis = new FakeRedis();
        const store = new CliRedisConfigStore({ client: redis });
        expect(store.keyPrefix).toBe(DEFAULT_REDIS_CONFIG_KEY_PREFIX);
        await store.write('jobs', 'history', { maxAge: '30d', tags: ['a'] });
        expect([...redis.hashes.keys()]).toEqual(['qcli:config:jobs:history']);
        const hash = Object.fromEntries(redis.hashes.get('qcli:config:jobs:history')!);
        expect(JSON.parse(hash.values)).toEqual({ maxAge: '30d', tags: ['a'] });
        expect(hash.version).toBe('1');
        expect(Number.isNaN(Date.parse(hash.updatedAt))).toBe(false);
        const custom = new CliRedisConfigStore({ client: redis, keyPrefix: 'app:settings/' });
        await custom.write('jobs', 'history', { a: 1 });
        expect(custom.keyOf('jobs', 'history')).toBe('app:settings/jobs:history');
        expect(redis.hashes.has('app:settings/jobs:history')).toBe(true);
        expect(await store.read('jobs', 'history')).toMatchObject({ version: 1 });
    });

    it('is the database source; persistent', () => {
        const store = new CliRedisConfigStore({ client: new FakeRedis() });
        expect(store.source).toBe('database');
        expect(store.describe().persistent).toBe(true);
    });

    it('describes itself by host, port, database and prefix', () => {
        expect(new CliRedisConfigStore({ client: new FakeRedis() }).describe()).toEqual({
            kind: 'redis',
            title: 'Redis',
            detail: 'cache:6379/0, prefix qcli:config',
            persistent: true,
        });
        const other = new CliRedisConfigStore({ client: new FakeRedis({ host: 'redis.internal', port: 6380, db: 3 }), keyPrefix: 'app:' });
        expect(other.describe().detail).toBe('redis.internal:6380/3, prefix app');
        expect(describeCliConfigStoreLine(other.describe())).toBe('Redis (redis.internal:6380/3, prefix app), kept across restarts');
        expect(new CliRedisConfigStore({ client: new FakeRedis({ path: '/run/redis.sock' }), keyPrefix: '' }).describe().detail).toBe('/run/redis.sock/0');
        expect(new CliRedisConfigStore({ client: new FakeRedis({}) }).describe().detail).toBe('localhost:6379/0, prefix qcli:config');
    });

    it('describe() never shows the password or user of a URL', async () => {
        const store = new CliRedisConfigStore({ url: 'redis://admin:s3cr3t-pass@cache.internal:6390/4', keyPrefix: 'qcli:cfg:' });
        try {
            const described = store.describe();
            expect(described).toEqual({ kind: 'redis', title: 'Redis', detail: 'cache.internal:6390/4, prefix qcli:cfg', persistent: true });
            expect(JSON.stringify(described)).not.toMatch(/s3cr3t|admin/);
            const only = new CliRedisConfigStore({ url: 'redis://:another-secret@localhost:6379' });
            expect(JSON.stringify(only.describe())).not.toContain('another-secret');
            await only.close();
        } finally {
            await store.close();
        }
    });

    it('needs a client or a url; refuses a bad TTL', () => {
        expect(() => new CliRedisConfigStore({})).toThrow('CliRedisConfigStore needs a client or a url');
        expect(() => new CliRedisConfigStore({ client: new FakeRedis(), ttlSeconds: -1 })).toThrow('ttlSeconds must be a whole number of seconds');
        expect(() => new CliRedisConfigStore({ client: new FakeRedis(), ttlSeconds: 1.5 })).toThrow('ttlSeconds');
    });

    it('a write that lost the race to another server with an expected version is a conflict carrying the version that won', async () => {
        const redis = new FakeRedis();
        const store = new CliRedisConfigStore({ client: redis });
        const other = new CliRedisConfigStore({ client: redis });
        await store.write('p', 's', { a: 1 });
        // Between this server's read and its script, the other one writes
        redis.beforeEval = () => other.write('p', 's', { a: 'theirs' }).then(() => undefined);
        const err = await store.write('p', 's', { a: 'mine' }, 1).catch((e) => e);
        expect(err).toBeInstanceOf(CliConfigConflictError);
        expect(err.currentVersion).toBe('2');
        expect(await store.read('p', 's')).toEqual({ values: { a: 'theirs' }, version: 2 });
    });

    it('a write without an expected version that lost the race is retried on the new values: no change lost', async () => {
        const redis = new FakeRedis();
        const store = new CliRedisConfigStore({ client: redis });
        const other = new CliRedisConfigStore({ client: redis });
        await store.write('p', 's', { a: 1 });
        redis.beforeEval = () => other.write('p', 's', { b: 2 }).then(() => undefined);
        expect(await store.write('p', 's', { c: 3 })).toEqual({ values: { a: 1, b: 2, c: 3 }, version: 3 });
        expect(redis.calls.filter((c) => c.startsWith('EVAL')).length).toBe(4);
    });

    it('gives up after maxRetries when the section keeps changing', async () => {
        const redis = new FakeRedis();
        const store = new CliRedisConfigStore({ client: redis, maxRetries: 2 });
        const other = new CliRedisConfigStore({ client: redis });
        let racing = 0;
        const race = async () => {
            racing++;
            await other.write('p', 's', { n: racing });
            redis.beforeEval = race;
        };
        redis.beforeEval = race;
        await expect(store.write('p', 's', { mine: true })).rejects.toThrow('config section p.s: too many concurrent writes');
        redis.beforeEval = undefined;
        expect(racing).toBe(3);
    });

    it('ttlSeconds expires a section after its last change; none by default', async () => {
        const redis = new FakeRedis();
        await new CliRedisConfigStore({ client: redis }).write('p', 'kept', { a: 1 });
        await new CliRedisConfigStore({ client: redis, ttlSeconds: 3600 }).write('p', 'expiring', { a: 1 });
        expect(redis.ttls.has('qcli:config:p:kept')).toBe(false);
        expect(redis.ttls.get('qcli:config:p:expiring')).toBe(3600);
    });

    it('unreadable values or versions read as empty', async () => {
        const redis = new FakeRedis();
        redis.hashes.set('qcli:config:p:s', new Map([['values', '{oops'], ['version', 'x']]));
        redis.hashes.set('qcli:config:p:t', new Map([['values', '[1,2]'], ['version', '4']]));
        const store = new CliRedisConfigStore({ client: redis });
        expect(await store.read('p', 's')).toEqual({ values: {}, version: 0 });
        expect(await store.read('p', 't')).toEqual({ values: {}, version: 4 });
    });

    it('an unexpected script reply is an error', async () => {
        const redis = new FakeRedis();
        redis.eval = async () => 'nope';
        await expect(new CliRedisConfigStore({ client: redis }).write('p', 's', { a: 1 })).rejects.toThrow('unexpected reply from Redis: "nope"');
    });

    it('close() ends only a client it created', async () => {
        const shared = new FakeRedis();
        await new CliRedisConfigStore({ client: shared }).close();
        expect(shared.quitCalled).toBe(false);
    });

    it('is listed as an installed plugin package', () => {
        expect(configRedisInstalledPlugin).toMatchObject({ id: '@qodalis/cli-server-plugin-config-redis', name: 'Config.Redis', icon: '🔴' });
        expect(configRedisInstalledPlugin.version).toMatch(/^1\./);
    });
});

describe('CliRedisConfigStore for one provider of a server', () => {
    it('jobs-like provider in Redis, the rest in the default store: GET /config and config list show it', async () => {
        const redis = new FakeRedis({ host: 'cache', port: 6379, db: 0 });
        const redisStore = new CliRedisConfigStore({ client: redis });
        const fallback = new InMemoryConfigStore();
        const limits = { maxAge: '30d' };
        const provider = new CliStoredConfigProvider({
            id: 'history',
            title: 'History',
            sections: [{ id: 'main', settings: [{ key: 'maxAge', type: 'string', default: '30d', apply: (v) => (limits.maxAge = String(v)) }] }],
        });
        const cli = createCliServer({ config: { store: fallback, stores: { history: redisStore } }, configure: (b) => b.addConfigProvider(provider) });
        await cli.config.ready();
        const all = await cli.config.list({ hasPermission: () => true });
        expect(all.find((p) => p.id === 'history')!.store).toEqual({ kind: 'redis', title: 'Redis', detail: 'cache:6379/0, prefix qcli:config', persistent: true });
        expect(all.find((p) => p.id === 'custom')!.store).toEqual({ kind: 'memory', title: 'In memory', detail: '', persistent: false });
        await cli.config.update('history', 'main', { changes: { maxAge: '7d' } }, { hasPermission: () => true });
        expect(limits.maxAge).toBe('7d');
        expect(JSON.parse(redis.hashes.get('qcli:config:history:main')!.get('values')!)).toEqual({ maxAge: '7d' });
        expect(await fallback.read('history', 'main')).toEqual({ values: {}, version: 0 });
        const res = await request(cli.app).post('/api/v1/qcli/execute').send({ command: 'config', chainCommands: ['list'], rawCommand: 'config list' });
        const text = (res.body?.outputs ?? []).map((o: any) => o.value).join('\n');
        expect(text).toContain('history  History  · Redis (cache:6379/0, prefix qcli:config)');
    });
});

const REDIS_URL = process.env.QCLI_TEST_REDIS;
const realStores: CliRedisConfigStore[] = [];
const runPrefix = `qcli:test:${process.pid}:${Date.now()}:`;
let realCount = 0;
describe.skipIf(!REDIS_URL)('CliRedisConfigStore (real Redis, QCLI_TEST_REDIS)', () => {
    afterAll(async () => {
        const { default: Redis } = await import('ioredis');
        const client = new Redis(REDIS_URL!);
        const keys = await client.keys(`${runPrefix}*`);
        if (keys.length) await client.del(...keys);
        await client.quit();
        await Promise.all(realStores.map((s) => s.close()));
    });

    storeContract('CliRedisConfigStore (real Redis)', async () => {
        const store = new CliRedisConfigStore({ url: REDIS_URL, keyPrefix: `${runPrefix}${realCount++}:` });
        realStores.push(store);
        return store;
    });

    it('two stores (two servers) racing on one section: no change lost, stale versions refused', async () => {
        const a = new CliRedisConfigStore({ url: REDIS_URL, keyPrefix: `${runPrefix}race:` });
        const b = new CliRedisConfigStore({ url: REDIS_URL, keyPrefix: `${runPrefix}race:` });
        realStores.push(a, b);
        await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).write('p', 's', { [`k${i}`]: i })));
        const final = await a.read('p', 's');
        expect(final.version).toBe(10);
        expect(Object.keys(final.values)).toHaveLength(10);
        await expect(b.write('p', 's', { k0: 'x' }, 3)).rejects.toBeInstanceOf(CliConfigConflictError);
    });
});
