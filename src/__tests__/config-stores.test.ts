/**
 * Config stores: in memory, JSON file and database (SQLite here; PostgreSQL with
 * QCLI_TEST_POSTGRES): versions, conflicts, removals, persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
    CliConfigConflictError,
    InMemoryConfigStore,
    JsonFileConfigStore,
    applyCliConfigChanges,
    type ICliConfigStore,
} from '@qodalis/cli-server-abstractions';
import { CliDatabaseConfigStore, CliMigrationRunner, postgresConnection, sqliteConnection } from '@qodalis/cli-server-plugin-databases';

/** The behaviour every store shares. */
function storeContract(name: string, create: () => Promise<ICliConfigStore>, cleanup?: () => Promise<void>) {
    describe(`${name}: the store contract`, () => {
        let store: ICliConfigStore;
        beforeEach(async () => {
            store = await create();
        });
        afterEach(async () => {
            await cleanup?.();
        });

        it('an unknown section is empty at version 0', async () => {
            expect(await store.read('p', 's')).toEqual({ values: {}, version: 0 });
        });

        it('writes bump the version by one and keep the values', async () => {
            const first = await store.write('p', 's', { a: 1, b: ['x'] });
            expect(first).toEqual({ values: { a: 1, b: ['x'] }, version: 1 });
            const second = await store.write('p', 's', { c: { deep: true } });
            expect(second).toEqual({ values: { a: 1, b: ['x'], c: { deep: true } }, version: 2 });
            expect(await store.read('p', 's')).toEqual(second);
        });

        it('null removes a key (reset)', async () => {
            await store.write('p', 's', { a: 1, b: 2 });
            const after = await store.write('p', 's', { a: null });
            expect(after.values).toEqual({ b: 2 });
            expect(after.version).toBe(2);
        });

        it('sections and providers are independent', async () => {
            await store.write('p', 's1', { a: 1 });
            await store.write('p', 's2', { a: 2 });
            await store.write('q', 's1', { a: 3 });
            expect((await store.read('p', 's1')).values).toEqual({ a: 1 });
            expect((await store.read('p', 's2')).values).toEqual({ a: 2 });
            expect((await store.read('q', 's1')).values).toEqual({ a: 3 });
            expect((await store.read('q', 's1')).version).toBe(1);
        });

        it('the expected version must match: a stale one is a conflict carrying the current version', async () => {
            await store.write('p', 's', { a: 1 }, 0);
            await store.write('p', 's', { a: 2 }, 1);
            const err = await store.write('p', 's', { a: 3 }, 1).catch((e) => e);
            expect(err).toBeInstanceOf(CliConfigConflictError);
            expect(err.currentVersion).toBe('2');
            expect((await store.read('p', 's')).values).toEqual({ a: 2 });
        });

        it('a first write with an expected version other than 0 is a conflict', async () => {
            await expect(store.write('p', 'new', { a: 1 }, 3)).rejects.toBeInstanceOf(CliConfigConflictError);
            expect(await store.read('p', 'new')).toEqual({ values: {}, version: 0 });
        });

        it('returned values are copies', async () => {
            const written = await store.write('p', 's', { list: ['a'] });
            (written.values.list as string[]).push('mutated');
            const read = await store.read('p', 's');
            (read.values.list as string[]).push('again');
            expect((await store.read('p', 's')).values.list).toEqual(['a']);
        });

        it('secrets are stored as given', async () => {
            await store.write('p', 's', { apiKey: 'sk_live_1' });
            expect((await store.read('p', 's')).values.apiKey).toBe('sk_live_1');
        });
    });
}

describe('applyCliConfigChanges', () => {
    it('sets, replaces and removes without touching the input', () => {
        const values = { a: 1, b: 2 };
        expect(applyCliConfigChanges(values, { a: 3, b: null, c: 'x' })).toEqual({ a: 3, c: 'x' });
        expect(values).toEqual({ a: 1, b: 2 });
    });
});

storeContract('InMemoryConfigStore', async () => new InMemoryConfigStore());

describe('InMemoryConfigStore', () => {
    it('is the runtime source', () => {
        expect(new InMemoryConfigStore().source).toBe('runtime');
    });
});

let tempDir: string;
storeContract(
    'JsonFileConfigStore',
    async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-config-'));
        return new JsonFileConfigStore(path.join(tempDir, 'config.json'));
    },
    async () => fs.rmSync(tempDir, { recursive: true, force: true }),
);

describe('JsonFileConfigStore', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-config-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('is the file source and persists across instances, in the documented shape', async () => {
        const file = path.join(dir, 'nested', 'config.json');
        const store = new JsonFileConfigStore(file);
        expect(store.source).toBe('file');
        await store.write('custom', 'custom', { motd: 'hi' });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ custom: { custom: { values: { motd: 'hi' }, version: 1 } } });
        const again = new JsonFileConfigStore(file);
        expect(await again.read('custom', 'custom')).toEqual({ values: { motd: 'hi' }, version: 1 });
    });

    it('writes the file readable by the owner only', async () => {
        if (process.platform === 'win32') return;
        const file = path.join(dir, 'config.json');
        await new JsonFileConfigStore(file).write('p', 's', { secret: 'x' });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(dir)).toEqual(['config.json']);
    });

    it('a missing or empty file is empty', async () => {
        const file = path.join(dir, 'config.json');
        expect(await new JsonFileConfigStore(file).read('p', 's')).toEqual({ values: {}, version: 0 });
        fs.writeFileSync(file, '  \n');
        expect(await new JsonFileConfigStore(file).read('p', 's')).toEqual({ values: {}, version: 0 });
    });

    it('refuses a file that is not JSON', async () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, '{oops');
        await expect(new JsonFileConfigStore(file).read('p', 's')).rejects.toThrow(/is not valid JSON/);
    });

    it('ignores malformed sections and versions', async () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, JSON.stringify({ p: { s: { values: [1], version: -3 }, t: 'x', u: { values: { a: 1 }, version: 2 } }, q: [] }));
        const store = new JsonFileConfigStore(file);
        expect(await store.read('p', 's')).toEqual({ values: {}, version: 0 });
        expect(await store.read('p', 't')).toEqual({ values: {}, version: 0 });
        expect(await store.read('p', 'u')).toEqual({ values: { a: 1 }, version: 2 });
    });

    it('a failed write leaves the file and the cache as they were', async () => {
        if (process.platform === 'win32' || process.getuid?.() === 0) return;
        const sub = path.join(dir, 'ro');
        fs.mkdirSync(sub);
        const file = path.join(sub, 'config.json');
        const store = new JsonFileConfigStore(file);
        await store.write('p', 's', { a: 1 });
        fs.chmodSync(sub, 0o500);
        try {
            await expect(store.write('p', 's', { a: 2 })).rejects.toThrow();
            expect(await store.read('p', 's')).toEqual({ values: { a: 1 }, version: 1 });
        } finally {
            fs.chmodSync(sub, 0o700);
        }
    });
});

let sqlite: Database.Database;
storeContract(
    'CliDatabaseConfigStore (SQLite)',
    async () => {
        sqlite = new Database(':memory:');
        const store = new CliDatabaseConfigStore({ connection: sqliteConnection(sqlite) });
        await store.ready;
        return store;
    },
    async () => sqlite.close(),
);

describe('CliDatabaseConfigStore', () => {
    it('is the database source; creates QcliConfig through the qcli-config migration', async () => {
        const db = new Database(':memory:');
        const store = new CliDatabaseConfigStore({ connection: sqliteConnection(db) });
        await store.ready;
        expect(store.source).toBe('database');
        expect(store.migrationSource.name).toBe('qcli-config');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r: any) => r.name);
        expect(tables).toContain('QcliConfig');
        expect(tables).toContain('QcliMigrations');
        const applied = db.prepare('SELECT "Source", "Id" FROM "QcliMigrations"').all();
        expect(applied).toEqual([{ Source: 'qcli-config', Id: '1' }]);
        db.close();
    });

    it('stores one row per section with its values as JSON', async () => {
        const db = new Database(':memory:');
        const store = new CliDatabaseConfigStore({ connection: sqliteConnection(db) });
        await store.write('cors', 'cors', { allowedOrigins: ['https://a.example'] });
        const rows = db.prepare('SELECT "Provider", "Section", "Version", "Data" FROM "QcliConfig"').all() as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ Provider: 'cors', Section: 'cors', Version: 1 });
        expect(JSON.parse(rows[0].Data)).toEqual({ allowedOrigins: ['https://a.example'] });
        db.close();
    });

    it('persists across stores on the same database (a restart)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-config-db-'));
        try {
            const file = path.join(dir, 'config.db');
            const a = new Database(file);
            await new CliDatabaseConfigStore({ connection: sqliteConnection(a) }).write('p', 's', { x: 1 });
            a.close();
            const b = new Database(file);
            const store = new CliDatabaseConfigStore({ connection: sqliteConnection(b) });
            expect(await store.read('p', 's')).toEqual({ values: { x: 1 }, version: 1 });
            b.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('table prefix and per-table name', async () => {
        const db = new Database(':memory:');
        await new CliDatabaseConfigStore({ connection: sqliteConnection(db), tablePrefix: 'App' }).write('p', 's', { a: 1 });
        await new CliDatabaseConfigStore({ connection: sqliteConnection(db), tables: { Config: 'Settings' } }).write('p', 's', { a: 1 });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
        expect(tables).toEqual(expect.arrayContaining(['AppConfig', 'Settings']));
        expect(() => new CliDatabaseConfigStore({ connection: sqliteConnection(db), tables: { Config: 'bad name' } })).toThrow('invalid table name');
        db.close();
    });

    it('a conflict rolls the transaction back', async () => {
        const db = new Database(':memory:');
        const store = new CliDatabaseConfigStore({ connection: sqliteConnection(db) });
        await store.write('p', 's', { a: 1 });
        await expect(store.write('p', 's', { a: 2 }, 0)).rejects.toBeInstanceOf(CliConfigConflictError);
        expect(db.inTransaction).toBe(false);
        expect(await store.read('p', 's')).toEqual({ values: { a: 1 }, version: 1 });
        // Still usable
        expect((await store.write('p', 's', { a: 3 }, 1)).version).toBe(2);
        db.close();
    });

    it('corrupt data reads as empty', async () => {
        const db = new Database(':memory:');
        const store = new CliDatabaseConfigStore({ connection: sqliteConnection(db) });
        await store.write('p', 's', { a: 1 });
        db.prepare('UPDATE "QcliConfig" SET "Data" = ?').run('{nope');
        expect(await store.read('p', 's')).toEqual({ values: {}, version: 1 });
        db.close();
    });

    it('can be shown in the databases plugin (migration source and connection)', async () => {
        const db = new Database(':memory:');
        const store = new CliDatabaseConfigStore({ connection: sqliteConnection(db) });
        await store.ready;
        const runner = new CliMigrationRunner('config', { connection: store.connection }).addSource(store.migrationSource);
        const states = await runner.status();
        expect(states.map((s) => `${s.source}:${s.id}:${s.status}`)).toEqual(['qcli-config:1:applied']);
        db.close();
    });
});

const PG = process.env.QCLI_TEST_POSTGRES;
describe.skipIf(!PG)('CliDatabaseConfigStore (PostgreSQL)', () => {
    it('writes, reads and refuses a stale version', async () => {
        const { Pool } = await import('pg');
        const pool = new Pool({ connectionString: PG });
        const table = `QcliConfigTest${Date.now()}`;
        try {
            const store = new CliDatabaseConfigStore({ connection: postgresConnection(pool), tables: { Config: table } });
            await store.ready;
            expect(await store.write('p', 's', { a: 1 })).toEqual({ values: { a: 1 }, version: 1 });
            await expect(store.write('p', 's', { a: 2 }, 0)).rejects.toBeInstanceOf(CliConfigConflictError);
            // Concurrent writers never lose a change
            await Promise.all(Array.from({ length: 5 }, (_, i) => store.write('p', 's', { [`k${i}`]: i })));
            const final = await store.read('p', 's');
            expect(final.version).toBe(6);
            expect(Object.keys(final.values).sort()).toEqual(['a', 'k0', 'k1', 'k2', 'k3', 'k4']);
        } finally {
            await pool.query(`DROP TABLE IF EXISTS "${table}"`).catch(() => undefined);
            await pool.end();
        }
    });
});
