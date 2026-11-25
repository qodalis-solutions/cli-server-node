/** The relational databases the migrations plugin runs on. */
export type CliSqlDialect = 'postgres' | 'mysql' | 'mssql' | 'sqlite';

export const SQL_DIALECTS: readonly CliSqlDialect[] = ['postgres', 'mysql', 'mssql', 'sqlite'];

/** One connection held for a while (a lock, a transaction): every statement runs on it, in order. */
export interface CliSqlSession {
    readonly dialect: CliSqlDialect;
    /** One statement with positional parameters written `?` (converted to the driver's style); its rows. */
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    /** A script of one or more statements, without parameters (a migration's SQL). */
    exec(script: string): Promise<void>;
}

/** A database the plugin migrates: sessions on demand. Adapters below wrap the usual drivers. */
export interface CliSqlConnection {
    readonly dialect: CliSqlDialect;
    /**
     * The database's name when the driver exposes it (a SQLite database: its file name), for
     * descriptions; never a connection string or credentials.
     */
    readonly database?: string;
    /** Runs `fn` on a dedicated connection, released (or closed) afterwards. */
    session<T>(fn: (session: CliSqlSession) => Promise<T>): Promise<T>;
}

/** `?` placeholders (outside quotes) as `$1, $2` (PostgreSQL) or `@p1, @p2` (SQL Server). */
export function numberPlaceholders(sql: string, style: (n: number) => string): string {
    let n = 0;
    let quote: string | null = null;
    let out = '';
    for (const ch of sql) {
        if (quote) {
            if (ch === quote) quote = null;
            out += ch;
        } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
            quote = ch === '[' ? ']' : ch;
            out += ch;
        } else if (ch === '?') {
            out += style(++n);
        } else {
            out += ch;
        }
    }
    return out;
}

/**
 * A database's name for descriptions: the name itself, the last path segment of a connection URL
 * (`postgres://user:pass@host/db` gives `db`), or a SQLite file's name. Undefined when there is none.
 */
export function cliDatabaseName(value: unknown, file = false): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    let name = value.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(name) && name.includes('/')) {
        try {
            name = decodeURIComponent(new URL(name).pathname);
        } catch {
            return undefined;
        }
        file = true;
    } else if (name.includes('://') || name.includes('@') || name.includes(';') || name.includes('=')) {
        // A connection string, not a name: never shown
        return undefined;
    }
    if (file) name = name.split(/[\\/]/).filter(Boolean).pop() ?? '';
    return name || undefined;
}

// Structural types of the drivers, so the plugin needs none of them installed
interface PgClient {
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
}
interface PgPool {
    connect(): Promise<PgClient>;
    options?: { database?: string; connectionString?: string };
}
interface MysqlConnection {
    query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
    release(): void;
}
interface MysqlPool {
    getConnection(): Promise<MysqlConnection>;
    pool?: { config?: { connectionConfig?: { database?: string } } };
}
interface MssqlRequest {
    input(name: string, value: unknown): MssqlRequest;
    query(sql: string): Promise<{ recordset?: unknown[] }>;
    batch(sql: string): Promise<unknown>;
}
interface MssqlPool {
    config: Record<string, unknown>;
    request(): MssqlRequest;
    connect(): Promise<MssqlPool>;
    close(): Promise<void>;
}
interface SqliteStatement {
    reader: boolean;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): unknown;
    name?: string;
}

/** A PostgreSQL database from a `pg` Pool. */
export function postgresConnection(pool: PgPool): CliSqlConnection {
    return {
        dialect: 'postgres',
        database: cliDatabaseName(pool.options?.database) ?? cliDatabaseName(pool.options?.connectionString),
        async session(fn) {
            const client = await pool.connect();
            try {
                return await fn({
                    dialect: 'postgres',
                    query: async <T,>(sql: string, params: readonly unknown[] = []) =>
                        (await client.query(numberPlaceholders(sql, (n) => `$${n}`), [...params])).rows as T[],
                    exec: async (script) => {
                        await client.query(script);
                    },
                });
            } finally {
                client.release();
            }
        },
    };
}

/**
 * A MySQL / MariaDB database from a `mysql2/promise` pool. Migration scripts with several statements need the
 * pool created with `multipleStatements: true`. MySQL commits DDL statements on its own: a failing migration that
 * created a table leaves it behind.
 */
export function mysqlConnection(pool: MysqlPool): CliSqlConnection {
    return {
        dialect: 'mysql',
        database: cliDatabaseName(pool.pool?.config?.connectionConfig?.database),
        async session(fn) {
            const conn = await pool.getConnection();
            try {
                return await fn({
                    dialect: 'mysql',
                    query: async <T,>(sql: string, params: readonly unknown[] = []) => {
                        const [rows] = await conn.query(sql, [...params]);
                        return (Array.isArray(rows) ? rows : []) as T[];
                    },
                    exec: async (script) => {
                        await conn.query(script);
                    },
                });
            } finally {
                conn.release();
            }
        },
    };
}

/**
 * A SQL Server database from an `mssql` ConnectionPool. A session opens its own single connection (with the
 * pool's settings), so locks and transactions stay on it; `GO` lines split a script into batches.
 */
export function mssqlConnection(pool: MssqlPool): CliSqlConnection {
    return {
        dialect: 'mssql',
        database: cliDatabaseName(pool.config?.database),
        async session(fn) {
            const Pool = pool.constructor as new (config: Record<string, unknown>) => MssqlPool;
            const single = await new Pool({ ...pool.config, pool: { min: 1, max: 1 } }).connect();
            try {
                return await fn({
                    dialect: 'mssql',
                    query: async <T,>(sql: string, params: readonly unknown[] = []) => {
                        const request = single.request();
                        params.forEach((value, i) => request.input(`p${i + 1}`, value));
                        return ((await request.query(numberPlaceholders(sql, (n) => `@p${n}`))).recordset ?? []) as T[];
                    },
                    exec: async (script) => {
                        for (const batch of script.split(/^\s*GO\s*;?\s*$/im)) {
                            if (batch.trim()) await single.request().batch(batch);
                        }
                    },
                });
            } finally {
                await single.close();
            }
        },
    };
}

/**
 * A SQLite database from a `better-sqlite3` Database (one connection: sessions run one after another). When the
 * handle is shared with other code (e.g. the filesystem-sqlite provider), that code's statements are not queued: a
 * migration's code step must not await other I/O inside its transaction, or those statements land in it.
 */
export function sqliteConnection(db: SqliteDatabase): CliSqlConnection {
    let queue: Promise<unknown> = Promise.resolve();
    const session: CliSqlSession = {
        dialect: 'sqlite',
        query: async <T,>(sql: string, params: readonly unknown[] = []) => {
            const statement = db.prepare(sql);
            const values = params.map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'boolean' ? Number(v) : v));
            return (statement.reader ? statement.all(...values) : (statement.run(...values), [])) as T[];
        },
        exec: async (script) => {
            db.exec(script);
        },
    };
    return {
        dialect: 'sqlite',
        database: db.name === ':memory:' || db.name === '' ? undefined : cliDatabaseName(db.name, true),
        session(fn) {
            const run = queue.then(() => fn(session));
            queue = run.catch(() => undefined);
            return run;
        },
    };
}
