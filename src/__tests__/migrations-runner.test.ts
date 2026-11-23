/**
 * The migrations runner against real databases: SQLite always; PostgreSQL, MySQL and SQL Server when
 * QCLI_TEST_POSTGRES (connection string), QCLI_TEST_MYSQL (mysql:// URL) and QCLI_TEST_MSSQL (connection string)
 * are set. Each test uses its own table prefix, dropped afterwards.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import {
    CliMigrationRunner,
    codeSource,
    sqlFolderSource,
    adoptLegacyTable,
    columnExists,
    tableExists,
    postgresConnection,
    mysqlConnection,
    mssqlConnection,
    sqliteConnection,
    collectDatabaseStats,
    databaseSize,
    type CliSqlConnection,
    type CliMigrationRun,
} from '@qodalis/cli-server-plugin-databases';

interface Target {
    name: string;
    open(): Promise<{ connection: CliSqlConnection; close(): Promise<void> }>;
}

const targets: Target[] = [
    {
        name: 'sqlite',
        open: async () => {
            const db = new Database(':memory:');
            return { connection: sqliteConnection(db), close: async () => void db.close() };
        },
    },
];
if (process.env.QCLI_TEST_POSTGRES) {
    targets.push({
        name: 'postgres',
        open: async () => {
            const pool = new Pool({ connectionString: process.env.QCLI_TEST_POSTGRES, max: 4 });
            return { connection: postgresConnection(pool), close: () => pool.end() };
        },
    });
}
if (process.env.QCLI_TEST_MYSQL) {
    targets.push({
        name: 'mysql',
        open: async () => {
            const pool = mysql.createPool({ uri: process.env.QCLI_TEST_MYSQL, multipleStatements: true, connectionLimit: 4 });
            return { connection: mysqlConnection(pool as never), close: () => pool.end() };
        },
    });
}
if (process.env.QCLI_TEST_MSSQL) {
    targets.push({
        name: 'mssql',
        open: async () => {
            const pool = await new mssql.ConnectionPool(process.env.QCLI_TEST_MSSQL!).connect();
            return { connection: mssqlConnection(pool as never), close: () => pool.close() };
        },
    });
}

let counter = 0;
const unique = () => `T${process.pid % 1000}${Date.now() % 100000}${counter++}`;

/** SQL per dialect for a table `t` with an id column. */
const createTable = (t: string, extra = '') => ({
    postgres: `CREATE TABLE "${t}" ("Id" integer PRIMARY KEY${extra})`,
    sqlite: `CREATE TABLE "${t}" ("Id" INTEGER PRIMARY KEY${extra})`,
    mysql: `CREATE TABLE \`${t}\` (\`Id\` int PRIMARY KEY${extra.replace(/"/g, '`')})`,
    mssql: `CREATE TABLE [${t}] ([Id] int PRIMARY KEY${extra.replace(/"([^"]+)"/g, '[$1]')})`,
});
const dropTable = (t: string) => ({
    postgres: `DROP TABLE "${t}"`,
    sqlite: `DROP TABLE "${t}"`,
    mysql: `DROP TABLE \`${t}\``,
    mssql: `DROP TABLE [${t}]`,
});

describe.each(targets)('migrations runner on $name', (target) => {
    const opened: Array<{ close(): Promise<void>; connection: CliSqlConnection; prefix: string }> = [];

    async function setup() {
        const { connection, close } = await target.open();
        const prefix = unique();
        opened.push({ connection, close, prefix });
        return { connection, prefix, runner: (sources: Parameters<CliMigrationRunner['addSource']>[0][]) => {
            const runner = new CliMigrationRunner('main', { connection, tablePrefix: prefix });
            sources.forEach((s) => runner.addSource(s));
            return runner;
        } };
    }

    afterAll(async () => {
        for (const { connection, close, prefix } of opened) {
            await connection
                .session(async (db) => {
                    const like = `${prefix}%`;
                    const sql = {
                        postgres: "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE ?",
                        mysql: 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE ?',
                        mssql: 'SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE ?',
                        sqlite: "SELECT name AS t FROM sqlite_master WHERE type = 'table' AND name LIKE ?",
                    }[db.dialect];
                    for (const row of await db.query<{ t: string }>(sql, [like])) await db.exec(dropTable(row.t)[db.dialect]);
                })
                .catch(() => undefined);
            await close();
        }
    });

    it('collects the stats: version, size, largest tables and, on servers, connections and counters', async () => {
        const { connection, prefix, runner } = await setup();
        const t = `${prefix}S`;
        const insert = {
            postgres: `INSERT INTO "${t}" ("Id") VALUES (1), (2), (3)`,
            sqlite: `INSERT INTO "${t}" ("Id") VALUES (1), (2), (3)`,
            mysql: `INSERT INTO \`${t}\` (\`Id\`) VALUES (1), (2), (3)`,
            mssql: `INSERT INTO [${t}] ([Id]) VALUES (1), (2), (3)`,
        };
        await runner([codeSource('app', [{ id: '1', name: 'stats table', up: createTable(t)[connection.dialect] }])]).up();
        await connection.session((db) => db.exec(insert[connection.dialect]));
        if (connection.dialect === 'postgres') await connection.session((db) => db.exec(`ANALYZE "${t}"`));
        if (connection.dialect === 'mysql') await connection.session((db) => db.exec(`ANALYZE TABLE \`${t}\``));

        const stats = await collectDatabaseStats('main', connection);
        expect(stats).toMatchObject({ name: 'main', dialect: connection.dialect, unavailable: [] });
        expect(stats.server?.version).toMatch(/\d/);
        expect(stats.size?.bytes).toBeGreaterThan(0);
        expect(await databaseSize(connection)).toBeGreaterThan(0);
        const table = stats.tables?.find((x) => x.name === t);
        expect(stats.tables!.length).toBeLessThanOrEqual(10);
        if (connection.dialect === 'sqlite') {
            expect(table).toMatchObject({ name: t, rows: 3 });
            expect(stats.connections).toBeUndefined();
        } else {
            expect(stats.server?.uptimeSeconds).toBeGreaterThan(0);
            expect(stats.connections?.open).toBeGreaterThan(0);
            expect(stats.connections?.max).toBeGreaterThan(0);
            expect(stats.counters?.transactions ?? stats.counters?.queries).toBeGreaterThan(0);
            expect(stats.cacheHitRatio).toBeGreaterThanOrEqual(0);
            expect(stats.cacheHitRatio).toBeLessThanOrEqual(1);
        }
        // Small tables can rank below others; it is there when the database has at most 10 tables
        if (stats.tables!.length < 10) expect(table?.name).toBe(t);
    });

    it('applies a folder of SQL files in order, records them and the run, and has nothing to do afterwards', async () => {
        const { connection, prefix, runner } = await setup();
        const dir = mkdtempSync(join(tmpdir(), 'qcli-mig-'));
        const a = `${prefix}A`;
        const b = `${prefix}B`;
        writeFileSync(join(dir, `0002_create_b.up.sql`), createTable(b)[connection.dialect]);
        writeFileSync(join(dir, `0001_create_a.up.sql`), createTable(a)[connection.dialect]);
        writeFileSync(join(dir, `0001_create_a.down.sql`), dropTable(a)[connection.dialect]);
        writeFileSync(join(dir, `0010_add_c.up.sql`), createTable(`${prefix}C`)[connection.dialect]);
        const r = runner([sqlFolderSource(dir)]);

        expect((await r.status()).map((s) => [s.id, s.status, s.hasDown])).toEqual([
            ['0001', 'pending', true],
            ['0002', 'pending', false],
            ['0010', 'pending', false],
        ]);
        const run = (await r.up({ actor: 'root', trigger: 'api' })) as CliMigrationRun;
        expect(run.status).toBe('succeeded');
        expect(run.applied.map((x) => x.id)).toEqual(['0001', '0002', '0010']);
        const states = await r.status();
        expect(states.every((s) => s.status === 'applied' && s.appliedBy === 'root' && typeof s.appliedAt === 'string')).toBe(true);
        expect(states[0].name).toBe('create a');
        await connection.session(async (db) => {
            expect(await tableExists(db, a)).toBe(true);
            expect(await tableExists(db, `${prefix}Migrations`)).toBe(true);
            expect(await tableExists(db, `${prefix}MigrationRuns`)).toBe(true);
        });

        const again = (await r.up({ trigger: 'startup' })) as CliMigrationRun;
        expect(again.applied).toEqual([]);
        const runs = await r.runs(10, 0);
        expect(runs.total).toBe(2);
        expect(runs.items[1]).toMatchObject({ id: run.id, direction: 'up', status: 'succeeded', actor: 'root', trigger: 'api' });
        expect(runs.items[1].applied.map((x) => x.id)).toEqual(['0001', '0002', '0010']);
    });

    it('stops at --to, shows the SQL of a dry run and applies nothing for it', async () => {
        const { connection, prefix, runner } = await setup();
        const r = runner([
            codeSource('app', [
                { id: '1', name: 'one', up: createTable(`${prefix}One`) },
                { id: '2', name: 'two', up: createTable(`${prefix}Two`) },
            ]),
        ]);
        const dry = (await r.up({ dryRun: true })) as { sql: string };
        expect(dry.sql).toContain(`-- app:1 one (up)`);
        expect(dry.sql).toContain(`${prefix}Two`);
        expect((await r.status()).every((s) => s.status === 'pending')).toBe(true);

        const run = (await r.up({ to: '1' })) as CliMigrationRun;
        expect(run.applied.map((x) => x.id)).toEqual(['1']);
        expect((await r.status()).map((s) => s.status)).toEqual(['applied', 'pending']);
        await expect(r.up({ to: '9' })).rejects.toMatchObject({ status: 404 });
        await connection.session(async (db) => expect(await tableExists(db, `${prefix}Two`)).toBe(false));
    });

    it('refuses to run while an applied migration changed or went missing, unless forced', async () => {
        const { prefix, runner } = await setup();
        const one = { id: '1', name: 'one', up: createTable(`${prefix}One`) };
        await runner([codeSource('app', [one])]).up();

        const edited = runner([codeSource('app', [{ ...one, up: createTable(`${prefix}One`, ', "X" int') }, { id: '2', name: 'two', up: createTable(`${prefix}Two`) }])]);
        expect((await edited.status()).map((s) => s.status)).toEqual(['changed', 'pending']);
        await expect(edited.up()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('app:1 (changed)') });
        expect(((await edited.up({ force: true })) as CliMigrationRun).applied.map((x) => x.id)).toEqual(['2']);

        const gone = runner([codeSource('app', [{ id: '2', name: 'two', up: createTable(`${prefix}Two`) }])]);
        expect((await gone.status()).map((s) => [s.id, s.status])).toEqual([
            ['2', 'applied'],
            ['1', 'missing'],
        ]);
        await expect(gone.up()).rejects.toMatchObject({ status: 409 });
    });

    it('rolls a failing migration back, records the failure and marks it failed until it is fixed', async () => {
        const { connection, prefix, runner } = await setup();
        const t = `${prefix}Bad`;
        const bad = runner([
            codeSource('app', [
                { id: '1', name: 'ok', up: createTable(`${prefix}Ok`) },
                // the table is created, then the statement fails: the transaction undoes the table
                { id: '2', name: 'broken', up: async (db) => {
                    await db.exec(createTable(t)[db.dialect]);
                    await db.exec('SELECT * FROM no_such_table_here');
                } },
            ]),
        ]);
        const run = (await bad.up()) as CliMigrationRun;
        expect(run.status).toBe('failed');
        expect(run.applied.map((x) => x.id)).toEqual(['1']);
        expect(run.failed).toEqual({ source: 'app', id: '2' });
        expect(run.error).toMatch(/^app:2 broken: /);
        expect((await bad.status()).map((s) => s.status)).toEqual(['applied', 'failed']);
        // MySQL commits DDL on its own: only the transactional databases undo the table
        if (connection.dialect !== 'mysql') await connection.session(async (db) => expect(await tableExists(db, t)).toBe(false));

        const fixed = runner([
            codeSource('app', [
                { id: '1', name: 'ok', up: createTable(`${prefix}Ok`) },
                { id: '2', name: 'broken', up: async (db) => {
                    if (!(await tableExists(db, t))) await db.exec(createTable(t)[db.dialect]);
                } },
            ]),
        ]);
        expect(((await fixed.up()) as CliMigrationRun).status).toBe('succeeded');
        expect((await fixed.status()).map((s) => s.status)).toEqual(['applied', 'applied']);
    });

    it('rolls back to a migration with the down steps, and refuses without one', async () => {
        const { connection, prefix, runner } = await setup();
        const r = runner([
            codeSource('app', [
                { id: '1', name: 'one', up: createTable(`${prefix}One`), down: dropTable(`${prefix}One`) },
                { id: '2', name: 'two', up: createTable(`${prefix}Two`), down: dropTable(`${prefix}Two`) },
                { id: '3', name: 'three', up: createTable(`${prefix}Three`), down: dropTable(`${prefix}Three`) },
            ]),
        ]);
        await r.up();
        const dry = (await r.down({ to: '1', dryRun: true })) as { sql: string };
        expect(dry.sql.indexOf('app:3')).toBeLessThan(dry.sql.indexOf('app:2'));
        const run = (await r.down({ to: '1', actor: 'root' })) as CliMigrationRun;
        expect(run.direction).toBe('down');
        expect(run.applied.map((x) => x.id)).toEqual(['3', '2']);
        expect((await r.status()).map((s) => s.status)).toEqual(['applied', 'pending', 'pending']);
        await connection.session(async (db) => {
            expect(await tableExists(db, `${prefix}Two`)).toBe(false);
            expect(await tableExists(db, `${prefix}One`)).toBe(true);
        });
        expect(((await r.down({ to: 'base' })) as CliMigrationRun).applied.map((x) => x.id)).toEqual(['1']);

        const noDown = runner([codeSource('app', [{ id: '1', name: 'one', up: createTable(`${prefix}Solo`) }])]);
        await noDown.up();
        await expect(noDown.down({ to: 'base' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('no down step for app:1') });
    });

    it('applies sources in order, keeps their histories apart and tells sources apart in targets', async () => {
        const { prefix, runner } = await setup();
        const r = runner([
            codeSource('qcli-users', [{ id: '1', name: 'users', up: createTable(`${prefix}Users`) }]),
            codeSource('app', [{ id: '1', name: 'app', up: createTable(`${prefix}App`) }]),
        ]);
        await expect(r.up({ to: '1' })).rejects.toMatchObject({ status: 400 });
        const run = (await r.up({ to: 'qcli-users:1' })) as CliMigrationRun;
        expect(run.applied).toEqual([expect.objectContaining({ source: 'qcli-users', id: '1' })]);
        expect((await r.status()).map((s) => `${s.source}:${s.id}:${s.status}`)).toEqual(['qcli-users:1:applied', 'app:1:pending']);
    });

    it('answers busy for a second run while one is in progress, and waits when told to', async () => {
        const { prefix, runner } = await setup();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const r = runner([
            codeSource('app', [
                { id: '1', name: 'slow', up: async (db) => {
                    await gate;
                    await db.exec(createTable(`${prefix}Slow`)[db.dialect]);
                } },
            ]),
        ]);
        const first = r.up();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await expect(r.up()).rejects.toMatchObject({ status: 409 });
        const waiting = r.up({ wait: true });
        release();
        expect(((await first) as CliMigrationRun).applied.map((x) => x.id)).toEqual(['1']);
        expect(((await waiting) as CliMigrationRun).applied).toEqual([]);
    });

    it('adopts a table of a previous release: renamed with its columns, data kept', async () => {
        const { connection, prefix } = await setup();
        const legacy = `${prefix.toLowerCase()}_files`;
        const table = `${prefix}Files`;
        await connection.session(async (db) => {
            await db.exec(
                {
                    postgres: `CREATE TABLE "${legacy}" (id integer PRIMARY KEY, parent_path text)`,
                    sqlite: `CREATE TABLE "${legacy}" (id INTEGER PRIMARY KEY, parent_path TEXT)`,
                    mysql: `CREATE TABLE \`${legacy}\` (id int PRIMARY KEY, parent_path text)`,
                    mssql: `CREATE TABLE [${legacy}] (id int PRIMARY KEY, parent_path nvarchar(200))`,
                }[db.dialect],
            );
            await db.query(`INSERT INTO ${db.dialect === 'mysql' ? `\`${legacy}\`` : db.dialect === 'mssql' ? `[${legacy}]` : `"${legacy}"`} (id, parent_path) VALUES (?, ?)`, [7, '/docs']);
            expect(await adoptLegacyTable(db, legacy, table, { id: 'Id', parent_path: 'ParentPath' })).toBe(true);
            expect(await tableExists(db, legacy)).toBe(false);
            expect(await columnExists(db, table, 'ParentPath')).toBe(true);
            const q = (n: string) => (db.dialect === 'mysql' ? `\`${n}\`` : db.dialect === 'mssql' ? `[${n}]` : `"${n}"`);
            expect(await db.query(`SELECT ${q('Id')} AS id, ${q('ParentPath')} AS p FROM ${q(table)}`)).toEqual([{ id: 7, p: '/docs' }]);
            // nothing to adopt a second time
            expect(await adoptLegacyTable(db, legacy, table, { id: 'Id' })).toBe(false);
        });
    });
});
