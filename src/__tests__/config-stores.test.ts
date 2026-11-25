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
    describeCliConfigStore,
    describeCliConfigStoreLine,
    type ICliConfigStore,
} from '@qodalis/cli-server-abstractions';
import { storeContract } from './config-store-contract';
import { CliDatabaseConfigStore, CliMigrationRunner, cliDatabaseName, postgresConnection, sqliteConnection } from '@qodalis/cli-server-plugin-databases';

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

    it('describes itself: in memory, lost on restart', () => {
        expect(new InMemoryConfigStore().describe()).toEqual({ kind: 'memory', title: 'In memory', detail: '', persistent: false });
        expect(describeCliConfigStoreLine(describeCliConfigStore(new InMemoryConfigStore()))).toBe('In memory, changes are lost on restart');
    });
});

describe('describeCliConfigStore', () => {
    it("a store without describe() is a custom store named after its class; persistent unless it is the runtime source", () => {
        class RedisConfigStore extends InMemoryConfigStore {
            readonly source = 'database' as const;
        }
        const redis = new RedisConfigStore();
        (redis as { describe?: unknown }).describe = undefined;
        expect(describeCliConfigStore(redis)).toEqual({ kind: 'custom', title: 'Custom store', detail: 'RedisConfigStore', persistent: true });
        const plain: ICliConfigStore = { source: 'runtime', read: async () => ({ values: {}, version: 0 }), write: async () => ({ values: {}, version: 1 }) };
        expect(describeCliConfigStore(plain)).toEqual({ kind: 'custom', title: 'Custom store', detail: '', persistent: false });
    });

    it('a custom description is used as given', () => {
        const store: ICliConfigStore = {
            source: 'database',
            describe: () => ({ kind: 'database', title: 'Redis', detail: 'db 3', persistent: true }),
            read: async () => ({ values: {}, version: 0 }),
            write: async () => ({ values: {}, version: 1 }),
        };
        expect(describeCliConfigStoreLine(describeCliConfigStore(store))).toBe('Redis (db 3), kept across restarts');
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

    it('describes itself by the path relative to the app, or the file name only outside it', () => {
        expect(new JsonFileConfigStore(path.join(dir, 'qcli-demo-config.json')).describe()).toEqual({
            kind: 'file',
            title: 'JSON file',
            detail: 'qcli-demo-config.json',
            persistent: true,
        });
        expect(new JsonFileConfigStore(path.join(process.cwd(), 'data', 'config.json')).describe().detail).toBe('data/config.json');
        expect(new JsonFileConfigStore('qcli-demo-config.json').describe().detail).toBe('qcli-demo-config.json');
    });

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

let sectionDir: string;
storeContract(
    'JsonFileConfigStore (a section of a settings file)',
    async () => {
        sectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-config-section-'));
        const file = path.join(sectionDir, 'app.json');
        fs.writeFileSync(file, JSON.stringify({ logging: { level: 'info' }, app: { name: 'demo' } }, null, 4));
        return new JsonFileConfigStore(file, { section: 'app.qcli' });
    },
    async () => fs.rmSync(sectionDir, { recursive: true, force: true }),
);

describe('JsonFileConfigStore with a section (an app settings file)', () => {
    let dir: string;
    let file: string;
    const original = {
        ConnectionStrings: { main: 'Server=db;Password=keep-me' },
        logging: { level: 'info', targets: ['console', 'file'] },
        port: 8080,
        flags: [true, false],
    };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-config-section-'));
        file = path.join(dir, 'app.json');
        fs.writeFileSync(file, `${JSON.stringify(original, null, 4)}\n`);
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('describes itself by the file and the section', () => {
        expect(new JsonFileConfigStore(file, { section: 'qcli' }).describe()).toEqual({
            kind: 'file',
            title: 'JSON file',
            detail: 'app.json, section qcli',
            persistent: true,
        });
        expect(new JsonFileConfigStore(path.join(process.cwd(), 'config', 'app.json'), { section: 'qcli' }).describe().detail).toBe('config/app.json, section qcli');
        expect(new JsonFileConfigStore(file, { section: 'app:qcli' }).describe().detail).toBe('app.json, section app.qcli');
        expect(describeCliConfigStoreLine(new JsonFileConfigStore(file, { section: 'qcli' }).describe())).toBe('JSON file (app.json, section qcli), kept across restarts');
    });

    it('keeps the settings under the section and the rest of the file as it was (keys, order, indentation, trailing newline)', async () => {
        const store = new JsonFileConfigStore(file, { section: 'qcli' });
        await store.write('jobs', 'history', { maxAge: '30d' });
        const text = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(text);
        expect(parsed).toEqual({ ...original, qcli: { jobs: { history: { values: { maxAge: '30d' }, version: 1 } } } });
        expect(Object.keys(parsed)).toEqual(['ConnectionStrings', 'logging', 'port', 'flags', 'qcli']);
        expect(text).toContain('\n    "logging": {\n        "level": "info"');
        expect(text.endsWith('}\n')).toBe(true);
    });

    it('a nested section (app.qcli or app:qcli) is created inside the existing object', async () => {
        fs.writeFileSync(file, JSON.stringify({ app: { name: 'demo' }, other: 1 }, null, 2));
        await new JsonFileConfigStore(file, { section: 'app:qcli' }).write('p', 's', { a: 1 });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ app: { name: 'demo', qcli: { p: { s: { values: { a: 1 }, version: 1 } } } }, other: 1 });
        expect(await new JsonFileConfigStore(file, { section: 'app.qcli' }).read('p', 's')).toEqual({ values: { a: 1 }, version: 1 });
    });

    it('re-reads the rest of the file on every write: edits made meanwhile are kept', async () => {
        const store = new JsonFileConfigStore(file, { section: 'qcli' });
        await store.write('p', 's', { a: 1 });
        const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
        edited.port = 9090;
        edited.added = 'by hand';
        fs.writeFileSync(file, JSON.stringify(edited, null, 4));
        await store.write('p', 's', { b: 2 });
        const after = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(after.port).toBe(9090);
        expect(after.added).toBe('by hand');
        expect(after.qcli.p.s).toEqual({ values: { a: 1, b: 2 }, version: 2 });
    });

    it('versions persist across instances (a restart) and a stale version is refused', async () => {
        await new JsonFileConfigStore(file, { section: 'qcli' }).write('p', 's', { a: 1 });
        const restarted = new JsonFileConfigStore(file, { section: 'qcli' });
        expect(await restarted.read('p', 's')).toEqual({ values: { a: 1 }, version: 1 });
        await expect(restarted.write('p', 's', { a: 2 }, 0)).rejects.toMatchObject({ currentVersion: '1' });
        expect((await restarted.write('p', 's', { a: 2 }, 1)).version).toBe(2);
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).qcli.p.s.version).toBe(2);
    });

    it('writes atomically: a temporary file renamed over the original (a new inode), none left behind; the file keeps its mode', async () => {
        if (process.platform === 'win32') return;
        fs.chmodSync(file, 0o644);
        const before = fs.statSync(file).ino;
        // A reader holding the old file sees it whole: it is replaced, never rewritten in place
        const held = fs.openSync(file, 'r');
        try {
            await new JsonFileConfigStore(file, { section: 'qcli' }).write('p', 's', { a: 1 });
            expect(JSON.parse(fs.readFileSync(held, 'utf8'))).toEqual(original);
        } finally {
            fs.closeSync(held);
        }
        expect(fs.statSync(file).ino).not.toBe(before);
        expect(fs.readdirSync(dir)).toEqual(['app.json']);
        expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    });

    it('a new settings file is created with the section, readable by the owner only', async () => {
        if (process.platform === 'win32') return;
        const fresh = path.join(dir, 'new', 'settings.json');
        await new JsonFileConfigStore(fresh, { section: 'qcli' }).write('p', 's', { a: 1 });
        expect(JSON.parse(fs.readFileSync(fresh, 'utf8'))).toEqual({ qcli: { p: { s: { values: { a: 1 }, version: 1 } } } });
        expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);
    });

    it('a section that is not an object, or a file that is not JSON, is refused and the file left untouched', async () => {
        fs.writeFileSync(file, JSON.stringify({ qcli: 'oops', app: [1] }));
        await expect(new JsonFileConfigStore(file, { section: 'qcli' }).read('p', 's')).rejects.toThrow(/qcli is not an object/);
        await expect(new JsonFileConfigStore(file, { section: 'app.qcli' }).read('p', 's')).rejects.toThrow(/app is not an object/);
        const store = new JsonFileConfigStore(file, { section: 'fresh' });
        expect(await store.read('p', 's')).toEqual({ values: {}, version: 0 });
        fs.writeFileSync(file, '{broken');
        await expect(store.write('p', 's', { a: 1 })).rejects.toThrow(/is not valid JSON/);
        expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
        // The failed change is not kept
        fs.writeFileSync(file, '{}');
        expect(await store.read('p', 's')).toEqual({ values: {}, version: 0 });
    });

    it('an empty part of the section path is refused', () => {
        expect(() => new JsonFileConfigStore(file, { section: 'app..qcli' })).toThrow('invalid config file section: app..qcli');
        expect(new JsonFileConfigStore(file, { section: '  ' }).sectionPath).toEqual([]);
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

    it('describes itself by dialect, database name and table; never credentials', async () => {
        const db = new Database(':memory:');
        const memory = new CliDatabaseConfigStore({ connection: sqliteConnection(db) });
        await memory.ready;
        expect(memory.describe()).toEqual({ kind: 'database', title: 'Database', detail: 'SQLite, table QcliConfig', persistent: true });
        const named = new CliDatabaseConfigStore({ connection: sqliteConnection(db), database: '/var/lib/app/qcli.db', tablePrefix: 'App' });
        await named.ready;
        expect(named.describe().detail).toBe('SQLite database qcli.db, table AppConfig');
        db.close();

        // PostgreSQL from a pool's connection string: the name only (the database is offline here)
        const pool = {
            options: { connectionString: 'postgresql://admin:s3cr3t@db.internal:5432/qcli?sslmode=require' },
            connect: async () => {
                throw new Error('offline');
            },
        };
        const connection = postgresConnection(pool as never);
        expect(connection.database).toBe('qcli');
        const pg = new CliDatabaseConfigStore({ connection, schema: 'qcli' });
        await pg.ready.catch(() => undefined);
        const described = pg.describe();
        expect(described.detail).toBe('PostgreSQL database qcli, table qcli.QcliConfig');
        expect(JSON.stringify(described)).not.toMatch(/s3cr3t|admin|db\.internal|5432/);
        expect(cliDatabaseName('Server=db;Database=qcli;User Id=sa;Password=s3cr3t')).toBeUndefined();
        expect(cliDatabaseName('mysql://root:s3cr3t@localhost/shop')).toBe('shop');
        expect(cliDatabaseName('orders')).toBe('orders');
        // A connection string given as the name is never shown
        const sqlServer = new CliDatabaseConfigStore({
            connection: { dialect: 'mssql', session: async () => { throw new Error('offline'); } },
            database: 'Server=db;Database=qcli;User Id=sa;Password=s3cr3t',
        });
        await sqlServer.ready.catch(() => undefined);
        expect(sqlServer.describe().detail).toBe('SQL Server, table QcliConfig');
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
