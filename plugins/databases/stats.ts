import type { CliSqlConnection, CliSqlDialect, CliSqlSession } from './connection';

/**
 * A database's size, connections, load counters and largest tables (`GET /api/v1/qcli/databases/:db/stats`).
 * Counters are cumulative since the server started: the dashboard turns two samples into rates. A metric the
 * database would not give (no permission, unsupported) is left out and listed in `unavailable`.
 */
export interface CliDatabaseStats {
    name: string;
    dialect: CliSqlDialect;
    collectedAt: string;
    server?: { version?: string; startedAt?: string; uptimeSeconds?: number };
    size?: { bytes?: number; dataBytes?: number; indexBytes?: number; logBytes?: number };
    connections?: { active?: number; open?: number; max?: number };
    counters?: { queries?: number; transactions?: number; commits?: number; rollbacks?: number; rowsRead?: number; rowsWritten?: number };
    /** Whether the counters are this database's or the whole server's (MySQL, SQL Server batches). */
    countersScope?: 'database' | 'server';
    /** Share of page reads served from memory, 0..1. */
    cacheHitRatio?: number;
    /** The largest tables (by size, else rows), at most 10. */
    tables?: CliDatabaseTableStats[];
    unavailable: Array<{ metric: string; error: string }>;
}

export interface CliDatabaseTableStats {
    schema?: string;
    name: string;
    rows?: number;
    bytes?: number;
}

type Stats = Omit<CliDatabaseStats, 'name' | 'dialect' | 'collectedAt' | 'unavailable'>;
type Collector = (db: CliSqlSession, stats: Stats) => Promise<void>;

const TOP_TABLES = 10;

/** A number from a driver value (bigint columns come back as strings); undefined when it is not one. */
function num(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    const n = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function iso(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function uptime(startedAt: string | undefined): number | undefined {
    return startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)) : undefined;
}

function ratio(hits: number | undefined, total: number | undefined): number | undefined {
    return hits !== undefined && total ? Math.min(1, Math.max(0, hits / total)) : undefined;
}

function topTables(tables: CliDatabaseTableStats[]): CliDatabaseTableStats[] {
    const bySize = tables.some((t) => t.bytes !== undefined);
    return [...tables].sort((a, b) => (bySize ? (b.bytes ?? 0) - (a.bytes ?? 0) : (b.rows ?? 0) - (a.rows ?? 0))).slice(0, TOP_TABLES);
}

const first = async (db: CliSqlSession, sql: string): Promise<Record<string, unknown>> => (await db.query<Record<string, unknown>>(sql))[0] ?? {};

const postgres: Record<string, Collector> = {
    server: async (db, s) => {
        const row = await first(db, 'SELECT version() AS "version", pg_postmaster_start_time() AS "startedAt"');
        const startedAt = iso(row.startedAt);
        // "PostgreSQL 17.2 (Debian 17.2-1) on x86_64-pc-linux-gnu, ..." -> "PostgreSQL 17.2"
        const version = String(row.version ?? '');
        s.server = { version: version.startsWith('PostgreSQL') ? version.split(' ').slice(0, 2).join(' ') : version, startedAt, uptimeSeconds: uptime(startedAt) };
    },
    size: async (db, s) => {
        const row = await first(
            db,
            `SELECT pg_database_size(current_database()) AS "bytes",
                    (SELECT COALESCE(SUM(pg_indexes_size(relid)), 0) FROM pg_stat_user_tables) AS "indexBytes"`,
        );
        const bytes = num(row.bytes);
        const indexBytes = num(row.indexBytes);
        s.size = { bytes, indexBytes, dataBytes: bytes !== undefined && indexBytes !== undefined ? bytes - indexBytes : undefined };
    },
    counters: async (db, s) => {
        const row = await first(
            db,
            `SELECT numbackends AS "open", xact_commit AS "commits", xact_rollback AS "rollbacks",
                    tup_returned + tup_fetched AS "rowsRead", tup_inserted + tup_updated + tup_deleted AS "rowsWritten",
                    blks_hit AS "hits", blks_read AS "reads",
                    (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS "active",
                    current_setting('max_connections') AS "max"
             FROM pg_stat_database WHERE datname = current_database()`,
        );
        const commits = num(row.commits);
        const rollbacks = num(row.rollbacks);
        const hits = num(row.hits);
        s.connections = { active: num(row.active), open: num(row.open), max: num(row.max) };
        s.counters = {
            transactions: commits !== undefined && rollbacks !== undefined ? commits + rollbacks : undefined,
            commits,
            rollbacks,
            rowsRead: num(row.rowsRead),
            rowsWritten: num(row.rowsWritten),
        };
        s.countersScope = 'database';
        s.cacheHitRatio = ratio(hits, (hits ?? 0) + (num(row.reads) ?? 0));
    },
    tables: async (db, s) => {
        const rows = await db.query<Record<string, unknown>>(
            `SELECT schemaname AS "schema", relname AS "name", n_live_tup AS "rows", pg_total_relation_size(relid) AS "bytes"
             FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT ${TOP_TABLES}`,
        );
        s.tables = topTables(rows.map((r) => ({ schema: String(r.schema), name: String(r.name), rows: num(r.rows), bytes: num(r.bytes) })));
    },
};

const MYSQL_STATUS = [
    'Uptime', 'Questions', 'Com_commit', 'Com_rollback', 'Innodb_rows_read',
    'Innodb_rows_inserted', 'Innodb_rows_updated', 'Innodb_rows_deleted', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests',
];

const mysql: Record<string, Collector> = {
    server: async (db, s) => {
        const version = String((await first(db, 'SELECT VERSION() AS version')).version ?? '');
        const status = await mysqlStatus(db, ['Uptime']);
        const up = status.Uptime;
        s.server = {
            version: `${/mariadb/i.test(version) ? 'MariaDB' : 'MySQL'} ${version}`,
            ...(up !== undefined ? { uptimeSeconds: up, startedAt: new Date(Date.now() - up * 1000).toISOString() } : {}),
        };
    },
    size: async (db, s) => {
        await mysqlFreshTableStats(db);
        const row = await first(
            db,
            `SELECT COALESCE(SUM(data_length), 0) AS dataBytes, COALESCE(SUM(index_length), 0) AS indexBytes
             FROM information_schema.tables WHERE table_schema = DATABASE()`,
        );
        const dataBytes = num(row.dataBytes) ?? 0;
        const indexBytes = num(row.indexBytes) ?? 0;
        s.size = { bytes: dataBytes + indexBytes, dataBytes, indexBytes };
    },
    connections: async (db, s) => {
        // This database's connections (every one with the PROCESS privilege, else the user's own)
        const row = await first(
            db,
            `SELECT COUNT(*) AS open, COALESCE(SUM(command NOT IN ('Sleep', 'Daemon')), 0) AS active
             FROM information_schema.processlist WHERE db = DATABASE()`,
        );
        const max = await first(db, 'SELECT @@max_connections AS max');
        s.connections = { active: num(row.active), open: num(row.open), max: num(max.max) };
    },
    counters: async (db, s) => {
        const v = await mysqlStatus(db, MYSQL_STATUS);
        const commits = v.Com_commit;
        const rollbacks = v.Com_rollback;
        const written = [v.Innodb_rows_inserted, v.Innodb_rows_updated, v.Innodb_rows_deleted];
        s.counters = {
            queries: v.Questions,
            transactions: commits !== undefined && rollbacks !== undefined ? commits + rollbacks : undefined,
            commits,
            rollbacks,
            rowsRead: v.Innodb_rows_read,
            rowsWritten: written.every((n) => n !== undefined) ? written.reduce((a, b) => a! + b!, 0) : undefined,
        };
        s.countersScope = 'server';
        const requests = v.Innodb_buffer_pool_read_requests;
        const reads = v.Innodb_buffer_pool_reads;
        s.cacheHitRatio = requests && reads !== undefined ? Math.min(1, Math.max(0, 1 - reads / requests)) : undefined;
    },
    tables: async (db, s) => {
        await mysqlFreshTableStats(db);
        const rows = await db.query<Record<string, unknown>>(
            `SELECT table_name AS name, table_rows AS \`rows\`, data_length + index_length AS bytes
             FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
             ORDER BY data_length + index_length DESC LIMIT ${TOP_TABLES}`,
        );
        s.tables = topTables(rows.map((r) => ({ name: String(r.name ?? r.NAME ?? r.TABLE_NAME), rows: num(r.rows), bytes: num(r.bytes) })));
    },
};

/** information_schema.tables caches InnoDB sizes (a day by default on MySQL 8): read them fresh. MariaDB has no such cache. */
async function mysqlFreshTableStats(db: CliSqlSession): Promise<void> {
    try {
        await db.exec('SET SESSION information_schema_stats_expiry = 0');
    } catch {
        // MariaDB, older MySQL
    }
}

async function mysqlStatus(db: CliSqlSession, names: string[]): Promise<Record<string, number | undefined>> {
    const rows = await db.query<Record<string, unknown>>(`SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map(() => '?').join(', ')})`, names);
    const values: Record<string, number | undefined> = {};
    for (const row of rows) values[String(row.Variable_name)] = num(row.Value);
    return values;
}

const mssql: Record<string, Collector> = {
    server: async (db, s) => {
        const row = await first(
            db,
            `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
                    CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition`,
        );
        s.server = { version: `SQL Server ${String(row.version ?? '')} ${String(row.edition ?? '')}`.trim() };
        try {
            const started = await first(db, 'SELECT sqlserver_start_time AS startedAt FROM sys.dm_os_sys_info');
            const startedAt = iso(started.startedAt);
            s.server = { ...s.server, startedAt, uptimeSeconds: uptime(startedAt) };
        } catch {
            // Needs VIEW SERVER STATE; the version is enough without it
        }
    },
    size: async (db, s) => {
        const row = await first(
            db,
            `SELECT CAST(SUM(CASE WHEN type = 0 THEN size ELSE 0 END) AS bigint) * 8192 AS dataBytes,
                    CAST(SUM(CASE WHEN type = 1 THEN size ELSE 0 END) AS bigint) * 8192 AS logBytes,
                    CAST(SUM(size) AS bigint) * 8192 AS bytes,
                    (SELECT CAST(COALESCE(SUM(used_page_count), 0) AS bigint) * 8192 FROM sys.dm_db_partition_stats WHERE index_id > 1) AS indexBytes
             FROM sys.database_files`,
        );
        s.size = { bytes: num(row.bytes), dataBytes: num(row.dataBytes), indexBytes: num(row.indexBytes), logBytes: num(row.logBytes) };
    },
    connections: async (db, s) => {
        const row = await first(
            db,
            `SELECT (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE database_id = DB_ID() AND is_user_process = 1) AS [open],
                    (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE database_id = DB_ID() AND session_id <> @@SPID) AS active,
                    @@MAX_CONNECTIONS AS max`,
        );
        s.connections = { active: num(row.active), open: num(row.open), max: num(row.max) };
    },
    counters: async (db, s) => {
        const rows = await db.query<Record<string, unknown>>(
            `SELECT RTRIM(counter_name) AS counter, RTRIM(instance_name) AS instance, cntr_value AS value
             FROM sys.dm_os_performance_counters
             WHERE counter_name IN ('Batch Requests/sec', 'Transactions/sec', 'Buffer cache hit ratio', 'Buffer cache hit ratio base')`,
        );
        if (rows.length === 0) throw new Error('no performance counters visible (VIEW SERVER STATE)');
        const value = (counter: string, instance?: string) =>
            num(rows.find((r) => r.counter === counter && (instance === undefined || r.instance === instance))?.value);
        const name = String((await first(db, 'SELECT DB_NAME() AS name')).name);
        s.counters = { queries: value('Batch Requests/sec'), transactions: value('Transactions/sec', name) };
        s.countersScope = 'server';
        s.cacheHitRatio = ratio(value('Buffer cache hit ratio'), value('Buffer cache hit ratio base'));
    },
    tables: async (db, s) => {
        const rows = await db.query<Record<string, unknown>>(
            `SELECT TOP ${TOP_TABLES} sc.name AS [schema], t.name AS name,
                    SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS [rows],
                    CAST(SUM(p.reserved_page_count) AS bigint) * 8192 AS bytes
             FROM sys.tables t
             JOIN sys.schemas sc ON sc.schema_id = t.schema_id
             JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id
             GROUP BY sc.name, t.name
             ORDER BY bytes DESC`,
        );
        s.tables = topTables(rows.map((r) => ({ schema: String(r.schema), name: String(r.name), rows: num(r.rows), bytes: num(r.bytes) })));
    },
};

const sqlite: Record<string, Collector> = {
    server: async (db, s) => {
        s.server = { version: `SQLite ${String((await first(db, 'SELECT sqlite_version() AS v')).v ?? '')}` };
    },
    size: async (db, s) => {
        const pages = num((await first(db, 'PRAGMA page_count')).page_count) ?? 0;
        const pageSize = num((await first(db, 'PRAGMA page_size')).page_size) ?? 0;
        s.size = { bytes: pages * pageSize };
    },
    tables: async (db, s) => {
        const tables = await db.query<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
        const bytes = new Map<string, number>();
        try {
            // dbstat is compiled into most builds (better-sqlite3's included); indexes count toward their table
            const rows = await db.query<{ tbl: string; bytes: number }>(
                `SELECT m.tbl_name AS tbl, SUM(d.pgsize) AS bytes FROM dbstat d JOIN sqlite_master m ON m.name = d.name GROUP BY m.tbl_name`,
            );
            for (const row of rows) bytes.set(row.tbl, Number(row.bytes));
        } catch {
            // No dbstat: rows only
        }
        const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
        // Without sizes, every table is ranked by its highest rowid (an index lookup, not a scan) before the counts
        const estimate = new Map<string, number>();
        if (!bytes.size) {
            for (const t of tables) {
                try {
                    estimate.set(t.name, num((await first(db, `SELECT MAX(rowid) AS n FROM ${quote(t.name)}`)).n) ?? 0);
                } catch {
                    estimate.set(t.name, 0); // a WITHOUT ROWID table
                }
            }
        }
        const ranked = bytes.size
            ? topTables(tables.map((t) => ({ name: t.name, bytes: bytes.get(t.name) }))).slice(0, TOP_TABLES)
            : tables
                  .map((t): CliDatabaseTableStats => ({ name: t.name }))
                  .sort((a, b) => (estimate.get(b.name) ?? 0) - (estimate.get(a.name) ?? 0))
                  .slice(0, TOP_TABLES);
        for (const table of ranked) {
            table.rows = num((await first(db, `SELECT COUNT(*) AS n FROM ${quote(table.name)}`)).n);
        }
        s.tables = topTables(ranked);
    },
};

const COLLECTORS: Record<CliSqlDialect, Record<string, Collector>> = { postgres, mysql, mssql, sqlite };

/** Collects the stats of a database; each metric group on its own, so one refused query leaves the rest. */
export async function collectDatabaseStats(name: string, connection: CliSqlConnection): Promise<CliDatabaseStats> {
    const stats: Stats = {};
    const unavailable: CliDatabaseStats['unavailable'] = [];
    await connection.session(async (db) => {
        for (const [metric, collect] of Object.entries(COLLECTORS[connection.dialect])) {
            try {
                await collect(db, stats);
            } catch (err) {
                unavailable.push({ metric, error: err instanceof Error ? err.message : String(err) });
            }
        }
    });
    return { name, dialect: connection.dialect, collectedAt: new Date().toISOString(), ...stats, unavailable };
}

/** Only the size in bytes (the databases list); undefined when it cannot be read. */
export async function databaseSize(connection: CliSqlConnection): Promise<number | undefined> {
    try {
        return await connection.session((db) => databaseSizeOn(db));
    } catch {
        return undefined;
    }
}

/** {@link databaseSize} in an open session; undefined when the database refuses it. */
export async function databaseSizeOn(db: CliSqlSession): Promise<number | undefined> {
    const stats: Stats = {};
    try {
        await COLLECTORS[db.dialect].size(db, stats);
    } catch {
        return undefined;
    }
    return stats.size?.bytes;
}
