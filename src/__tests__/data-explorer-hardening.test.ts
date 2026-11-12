/**
 * Data explorer hardening: per-source permissions, read-only sources, allowed objects,
 * column masking, rate limits, audit and export flags (spec: web-cli
 * docs/superpowers/specs/2026-11-12-data-explorer-hardening-design.md).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import request from 'supertest';
import {
    DataExplorerAuditEntry,
    DataExplorerLanguage,
    DataExplorerOutputFormat,
    DataExplorerProviderOptions,
    DataExplorerResult,
    IDataExplorerProvider,
} from '@qodalis/cli-server-abstractions';
import {
    DataExplorerExecutor,
    DataExplorerRegistry,
    AUDIT_QUERY_MAX_LENGTH,
} from '@qodalis/cli-server-plugin-data-explorer';
import {
    applyColumnPolicy,
    DataExplorerRateLimiter,
    filterSchema,
    isObjectAllowed,
    MASK,
    maskedColumnError,
    maskedResultError,
    fixNameCase,
    nameCaseHint,
    objectsError,
    readOnlyError,
    sqlObjects,
} from '../../plugins/data-explorer/data-explorer-policy';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult, InMemoryAuditStore } from '../../plugins/users/index';
import { DataExplorerMcpToolProvider } from '../mcp/providers/data-explorer-provider';

const L = DataExplorerLanguage;

function opts(extra: Partial<DataExplorerProviderOptions> = {}): DataExplorerProviderOptions {
    return {
        name: 'db',
        description: 'Test db',
        language: L.Sql,
        defaultOutputFormat: DataExplorerOutputFormat.Table,
        ...extra,
    };
}

function result(columns: string[] | null, rows: unknown[]): DataExplorerResult {
    return {
        success: true,
        source: 'db',
        language: L.Sql,
        defaultOutputFormat: DataExplorerOutputFormat.Table,
        executionTime: 1,
        columns,
        rows: rows as DataExplorerResult['rows'],
        rowCount: rows.length,
        truncated: false,
    };
}

function provider(res: () => DataExplorerResult = () => result(['id', 'email', 'password'], [[1, 'a@x.io', 'h1']])) {
    const executeAsync = vi.fn(async () => res());
    const p: IDataExplorerProvider = {
        executeAsync,
        getSchemaAsync: async () => ({
            source: 'db',
            tables: [
                { name: 'users', type: 'table', columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'password', type: 'text', nullable: false }] },
                { name: 'secrets', type: 'table', columns: [{ name: 'k', type: 'text', nullable: false }] },
            ],
        }),
    };
    return { provider: p, executeAsync };
}

// ---------------------------------------------------------------------------
// Read-only rules
// ---------------------------------------------------------------------------

describe('read-only rules', () => {
    it('SQL: allows reads, refuses writes and multiple statements', () => {
        for (const q of [
            'SELECT * FROM users',
            'select 1; ',
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "SELECT 'DELETE FROM users' AS s",
            'EXPLAIN SELECT * FROM users',
            '-- DROP TABLE users\nSELECT 1',
            'SHOW TABLES',
            "SELECT 'it''s'",
            'SELECT 1 # trailing MySQL comment',
            "SELECT E'it\\'s' AS s",
            'SELECT "a""b", [c]]d], `e``f` FROM t',
            'SELECT 1 /* a /* nested */ b */',
            'SELECT $1::int',
        ]) {
            expect(readOnlyError(L.Sql, q), q).toBeUndefined();
        }
        for (const q of [
            'DELETE FROM users',
            'update users set a = 1',
            'INSERT INTO users VALUES (1)',
            'DROP TABLE users',
            'SELECT 1; DELETE FROM users',
            'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
            'SELECT * INTO copy FROM users',
            'TRUNCATE users',
            'CREATE TABLE t (a int)',
            // A backslash is an escape only in MySQL: on SQL Server this is two statements
            "SELECT 'a\\'; DROP TABLE users; --'",
            // `#t` is a SQL Server temp table, not a comment hiding the rest of the line
            'SELECT * FROM #t; DROP TABLE users',
            // $$ quotes only in Postgres
            'SELECT $$; DROP TABLE users; $$',
            // MySQL: `--` needs a space (`1 --1` is 1 - -1), /*! ... */ runs, "..." is a string
            'SELECT 1 --1; COMMIT; DELETE FROM users',
            "SELECT 1 /*! INTO OUTFILE '/tmp/x' */",
            'SELECT "\\"" INTO OUTFILE \'/tmp/f\' -- "',
            // Postgres and SQL Server comments nest; SQL Server escapes ] as ]]
            "SELECT 1 /* /* */ ' */ COMMIT DROP TABLE users --'",
            "SELECT [x]]'] , 1 DROP TABLE users --'",
            // # is a comment only in MySQL
            'SELECT 1 # x\n; DROP TABLE users',
        ]) {
            expect(readOnlyError(L.Sql, q), q).toBeDefined();
        }
    });

    it('MongoDB: allows finds, refuses writes', () => {
        expect(readOnlyError(L.Shell, 'db.users.find({})')).toBeUndefined();
        expect(readOnlyError(L.Shell, 'show collections')).toBeUndefined();
        expect(readOnlyError(L.Shell, 'db.users.insertOne({a:1})')).toBeDefined();
        expect(readOnlyError(L.Shell, 'db.users.drop()')).toBeDefined();
        expect(readOnlyError(L.Shell, 'db.users.aggregate([{ $out: "x" }])')).toBeDefined();
        // MongoDB sources registered with the json language follow the same rules
        expect(readOnlyError(L.Json, 'db.users.find({})')).toBeUndefined();
        expect(readOnlyError(L.Json, 'db.users.deleteMany({})')).toBeDefined();
    });

    it('Redis: allows reads, refuses writes', () => {
        expect(readOnlyError(L.Redis, 'GET rates:usd')).toBeUndefined();
        expect(readOnlyError(L.Redis, 'hgetall h')).toBeUndefined();
        expect(readOnlyError(L.Redis, 'SET a 1')).toBeDefined();
        expect(readOnlyError(L.Redis, 'FLUSHALL')).toBeDefined();
    });

    it('Elasticsearch: allows GET and search POSTs, refuses writes', () => {
        expect(readOnlyError(L.Elasticsearch, 'GET /logs/_search')).toBeUndefined();
        expect(readOnlyError(L.Elasticsearch, 'POST /logs/_search\n{}')).toBeUndefined();
        expect(readOnlyError(L.Elasticsearch, 'DELETE /logs')).toBeDefined();
        expect(readOnlyError(L.Elasticsearch, 'POST /logs/_doc\n{}')).toBeDefined();
    });

    it('other languages cannot be checked and are refused', () => {
        expect(readOnlyError(L.Graphql, '{ users { id } }')).toContain('readOnly: false');
    });
});

// ---------------------------------------------------------------------------
// Allowed objects and columns
// ---------------------------------------------------------------------------

describe('allowed objects', () => {
    it('reads the tables a SQL query names', () => {
        expect(sqlObjects('SELECT * FROM public.users u JOIN orders o ON o.uid = u.id').sort()).toEqual(['orders', 'public.users']);
        expect(sqlObjects('SELECT * FROM "Users", [dbo].[orders]')).toEqual(['Users', 'dbo.orders']);
        // Read as each dialect reads its comments and brackets
        expect(sqlObjects("SELECT * FROM allowed /* /* */ ' */ , secret --'")).toContain('secret');
        expect(sqlObjects('SELECT arr[(SELECT 1 FROM secret)] FROM allowed')).toContain('secret');
    });

    it('matches qualified and unqualified patterns', () => {
        expect(isObjectAllowed('public.users', ['users'])).toBe(true);
        expect(isObjectAllowed('public.users', ['public.*'])).toBe(true);
        expect(isObjectAllowed('audit.users', ['public.*'])).toBe(false);
        expect(isObjectAllowed('rates:usd', ['rates:*'])).toBe(true);
    });

    it('refuses queries that read other objects', () => {
        const o = opts({ allowedObjects: ['users', 'orders'] });
        expect(objectsError(o, 'SELECT * FROM users')).toBeUndefined();
        expect(objectsError(o, 'SELECT * FROM users JOIN secrets ON 1=1')).toContain("'secrets'");
        expect(objectsError(opts({ language: L.Redis, allowedObjects: ['rates:*'] }), 'GET session:1')).toContain('session:1');
        expect(objectsError(opts({ language: L.Shell, allowedObjects: ['users'] }), 'db.secrets.find()')).toContain('secrets');
    });

    it('sees through quotes and comments the way MySQL and Postgres read them', () => {
        const o = opts({ allowedObjects: ['users'] });
        for (const q of [
            // MySQL: `$x$` is an identifier, `\'` an escape
            "SELECT 1 $x$, '\\'' a FROM secrets WHERE ''='' -- $x$",
            // Postgres: a backslash is no escape, `$x$` a quote
            "SELECT '\\', $x$ ' $x$ FROM secrets -- '",
            "SELECT $a1$ ' $a1$ FROM secrets -- '",
            "SELECT E'\\'' FROM secrets -- '",
            // Postgres: `#` is an operator, `[` a subscript
            'SELECT 1 # 2 FROM secrets',
            "SELECT (ARRAY[1,2])[(SELECT length(']'))] FROM secrets",
            // MySQL: `"…"` is a string with escapes, `#'` a comment, `--1` no comment, `/*! … */` runs
            'SELECT "\\"" a FROM secrets WHERE ""=""',
            "SELECT 1 #'\n FROM secrets -- '",
            'SELECT a--1, b FROM secrets',
            'SELECT 1 /*! FROM secrets */',
        ]) {
            expect(objectsError(o, q), q).toContain("'secrets'");
            expect(readOnlyError(L.Sql, q.replace('FROM secrets', 'FROM secrets; DELETE FROM users')), q).toBeDefined();
        }
        for (const q of ["SELECT $$ a ' b $$ FROM users", 'SELECT `name` FROM `users` WHERE x = "a"', 'SELECT * FROM [dbo].[users]']) {
            expect(objectsError(o, q), q).toBeUndefined();
            expect(readOnlyError(L.Sql, q), q).toBeUndefined();
        }
    });

    it('filters the schema: allowed tables, no dropped columns', () => {
        const schema = {
            source: 'db',
            tables: [
                { name: 'users', type: 'table', columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'password', type: 'text', nullable: false }] },
                { name: 'secrets', type: 'table', columns: [] },
            ],
        };
        const filtered = filterSchema(schema as any, opts({ allowedObjects: ['users'], dropColumns: ['password'] }));
        expect(filtered.tables.map((t) => t.name)).toEqual(['users']);
        expect(filtered.tables[0].columns.map((c) => c.name)).toEqual(['id']);
    });

    it('masks and drops columns in table and document results', () => {
        const o = opts({ maskColumns: ['email'], dropColumns: ['pass*'] });
        const table = applyColumnPolicy(result(['id', 'email', 'password'], [[1, 'a@x.io', 'h1'], [2, null, 'h2']]), o);
        expect(table.columns).toEqual(['id', 'email']);
        expect(table.rows).toEqual([[1, MASK], [2, null]]);
        const docs = applyColumnPolicy(result(null, [{ id: 1, email: 'a@x.io', password: 'h', nested: { email: 'b@x.io' } }]), o);
        expect(docs.rows).toEqual([{ id: 1, email: MASK, nested: { email: MASK } }]);
    });
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

describe('rules shared with the .NET server', () => {
    const exposesSecret = (q: string) => sqlObjects(q).some((o) => o.split('.').pop() === 'secret');

    it('SQL tokenizer: dollar tags, Unicode names, lone carriage returns, COMMIT/ROLLBACK/DENY', () => {
        for (const q of [
            "SELECT $a1$ ' $a1$; DELETE FROM users; -- '",
            'SELECT 1 --x\r; DELETE FROM users',
            'SELECT 1 COMMIT',
            'SELECT 1 ROLLBACK',
            "SELECT 1 /* /* */ ' */ COMMIT DROP TABLE users --'",
            'SELECT 1 DENY SELECT ON users TO public',
        ]) {
            expect(readOnlyError(L.Sql, q), JSON.stringify(q)).toBeDefined();
        }
        expect(readOnlyError(L.Sql, 'SELECT 1 --x\r; DELETE FROM users')).toBe('Read-only source: end lines with \\n or \\r\\n');
        expect(readOnlyError(L.Sql, 'SELECT 1 COMMIT')).toBe('Read-only source: COMMIT is not allowed');
        for (const q of ['SELECT $1::int', 'SELECT café FROM t', 'SELECT 1\r\nFROM t']) {
            expect(readOnlyError(L.Sql, q), JSON.stringify(q)).toBeUndefined();
        }
        expect(exposesSecret("SELECT $a1$ ' $a1$ FROM secret -- '")).toBe(true);
        expect(sqlObjects('SELECT * FROM état')).toContain('état');
        expect(objectsError(opts({ allowedObjects: ['t'] }), 'SELECT 1\rFROM t')).toBe(
            'This source only accepts queries that name the objects they read',
        );
    });

    it('SQL allowed objects: FROM and USING lists, CTE scope, db..table, DESCRIBE and EXPLAIN', () => {
        for (const q of [
            'SELECT * FROM (SELECT 1) a, secret',
            'SELECT * FROM allowed a, generate_series(1, 2) g, secret',
            'DELETE FROM allowed USING secret WHERE 1=1',
            'SELECT * FROM allowed WHERE EXISTS (WITH secret AS (SELECT 1) SELECT 1) UNION SELECT * FROM secret',
            'SELECT * FROM allowed..secret',
            'DESCRIBE secret',
            'EXPLAIN secret',
        ]) {
            expect(exposesSecret(q), q).toBe(true);
            expect(objectsError(opts({ allowedObjects: ['allowed'] }), q), q).toBeDefined();
        }
        expect(sqlObjects('SELECT EXTRACT(YEAR FROM day) AS y')).toEqual([]);
        expect(sqlObjects('WITH recent AS (SELECT * FROM users) SELECT * FROM recent')).toEqual(['users']);
        expect(sqlObjects('EXPLAIN ANALYZE SELECT 1')).toEqual([]);
        expect(sqlObjects('SELECT * FROM "sec""ret"')).toEqual(['sec"ret']);
    });

    it('SQL allowed objects: a quoted table is still the table under the MySQL reading, never WHERE or its alias', () => {
        for (const q of [
            `SELECT "Id" FROM "Users" WHERE "CountryCode" = 'RO'`,
            `SELECT u."Id" FROM "Users" u WHERE u."CountryCode" = 'RO' ORDER BY 1`,
            'SELECT * FROM "Users" AS u JOIN "Bots" b ON b."UserId" = u."Id"',
        ]) {
            expect(objectsError(opts({ allowedObjects: ['Users', 'Bots'] }), q), q).toBeUndefined();
        }
    });

    it('MongoDB: JSON escapes and the collections pipeline stages read', () => {
        expect(readOnlyError(L.Shell, 'db.users.aggregate([{ "\\u0024out": "x" }])')).toBe('Read-only source: $out and $merge are not allowed');
        const o = opts({ language: L.Shell, allowedObjects: ['users'] });
        expect(objectsError(o, 'db.users.aggregate([{ $match: {} }])')).toBeUndefined();
        for (const q of [
            'db.users.aggregate([{ $lookup: { from: "secret", localField: "a", foreignField: "b", as: "s" } }])',
            'db.users.aggregate([{ "$unionWith": "secret" }])',
            'db.users.aggregate([{ "$unionWith": { "coll": "secret" } }])',
            'db.users.aggregate([{ "\\u0024lookup": { "from": "secret" } }])',
            'db.users.aggregate([{ $graphLookup: { from: "secret", startWith: "$a", connectFromField: "a", connectToField: "b", as: "s" } }])',
        ]) {
            expect(objectsError(o, q), q).toBe("'secret' is not available on this source");
        }
        expect(objectsError(o, 'db.users.aggregate([{ $lookup: { from: name, as: "s" } }])')).toBe(
            'This source only accepts queries that name the objects they read',
        );
    });

    it('Elasticsearch: reads, bare paths and indices', () => {
        for (const q of ['GET /logs/_search', 'POST /logs/_search\n{}', 'POST /_all/_search\n{}', 'POST /logs/_validate/query\n{}']) {
            expect(readOnlyError(L.Elasticsearch, q), q).toBeUndefined();
        }
        for (const q of ['DELETE /logs', 'POST /logs/_doc\n{}', 'POST /logs/_delete_by_query#/_search\n{}', 'POST /logs/_doc/_search\n{}']) {
            expect(readOnlyError(L.Elasticsearch, q), q).toBeDefined();
        }
        expect(readOnlyError(L.Elasticsearch, 'POST /logs/_delete_by_query#/_search\n{}')).toBe(
            'Read-only source: POST /logs/_delete_by_query is not allowed',
        );
        const o = opts({ language: L.Elasticsearch, allowedObjects: ['logs'] });
        expect(objectsError(o, 'POST /logs/_search\n{"query":{"match_all":{}}}')).toBeUndefined();
        expect(objectsError(o, 'POST /logs/_msearch\n{"index":"secret"}\n{}')).toBe(
            'This source only accepts queries that name the objects they read',
        );
        expect(objectsError(opts({ language: L.Elasticsearch, allowedObjects: ['metrics-*'] }), 'GET /logs/_search')).toContain('logs');
    });

    it('Redis: words split as the provider splits them', () => {
        expect(objectsError(opts({ language: L.Redis, allowedObjects: ['rates:usd'] }), 'GET rates:usd')).toBeUndefined();
        expect(objectsError(opts({ language: L.Redis, allowedObjects: ['rates:usd'] }), "GET 'rates:usd'x")).toContain('rates:usdx');
        // A newline separates words, in the check and in the provider alike
        expect(objectsError(opts({ language: L.Redis, allowedObjects: ['rates:usd'] }), 'MGET rates:usd\nsecret')).toContain('secret');
        const o = opts({ language: L.Redis, allowedObjects: ['rates:*'] });
        expect(objectsError(o, 'GET session:1')).toContain('session:1');
        expect(objectsError(o, 'SCAN 0')).toBe('This source only accepts queries that name the objects they read');
        expect(readOnlyError(L.Redis, '')).toBe('Read-only source: this command is not allowed');
    });

    it('masks JSON text like a document', () => {
        const o = opts({ maskColumns: ['email'], dropColumns: ['pass*'] });
        const res = applyColumnPolicy(
            result(['response'], [['{"_source":{"email":"a@x.io","password":"h","id":1}}'], ['[not json']]),
            o,
        );
        expect(res.rows).toEqual([['{"_source":{"email":"***","id":1}}'], ['[not json']]);
    });
});

describe('name case hint', () => {
    const schema = {
        source: 'db',
        tables: [
            { name: 'public.Users', type: 'table', columns: [{ name: 'CountryCode', type: 'text', nullable: true }] },
            { name: 'job_states', type: 'table', columns: [{ name: 'status', type: 'text', nullable: true }] },
        ],
    };

    it.each([
        ['42P01: relation "users" does not exist\n\nPOSITION: 22', '"Users"'],
        ['42703: column "countrycode" does not exist', '"CountryCode"'],
        ['42703: column u.countrycode does not exist', '"CountryCode"'],
    ])('names the table or column with its capitals: %s', (error, quoted) => {
        expect(nameCaseHint(error, schema)).toBe(`Names with capital letters need double quotes: ${quoted}`);
    });

    it.each([
        // Nothing differs only in case, or the name is not shown (a hidden table is never named)
        ['42P01: relation "job_states" does not exist'],
        ['42P01: relation "onetimecodes" does not exist'],
        ['syntax error at or near "FORM"'],
    ])('says nothing else: %s', (error) => {
        expect(nameCaseHint(error, schema)).toBeUndefined();
    });

    function hinted(error: string, o: Partial<DataExplorerProviderOptions> = {}, thrown = false) {
        const registry = new DataExplorerRegistry();
        registry.register(
            {
                executeAsync: async () => {
                    if (thrown) throw new Error(error);
                    return { ...result(null, []), success: false, error };
                },
                getSchemaAsync: async () => ({
                    source: 'db',
                    tables: [
                        { name: 'public.Users', type: 'table', columns: [{ name: 'Id', type: 'int', nullable: false }, { name: 'Secret', type: 'text', nullable: true }] },
                        { name: 'public.OneTimeCodes', type: 'table', columns: [{ name: 'Code', type: 'text', nullable: false }] },
                    ],
                }),
            },
            opts(o),
        );
        return new DataExplorerExecutor(registry).executeAsync({ source: 'db', query: 'SELECT 1' });
    }

    it('adds the hint on a new line to a failed SQL query (answered or thrown)', async () => {
        expect((await hinted('relation "users" does not exist')).error).toBe(
            'relation "users" does not exist\nNames with capital letters need double quotes: "Users"',
        );
        expect((await hinted('column "id" does not exist', {}, true)).error).toBe(
            'column "id" does not exist\nNames with capital letters need double quotes: "Id"',
        );
    });

    it('names only tables the source shows and columns it does not drop', async () => {
        const o = { allowedObjects: ['Users'], dropColumns: ['Secret'] };
        expect((await hinted('relation "onetimecodes" does not exist', o)).error).toBe('relation "onetimecodes" does not exist');
        expect((await hinted('column "secret" does not exist', o)).error).toBe('column "secret" does not exist');
        expect((await hinted('relation "users" does not exist', o)).error).toContain('"Users"');
    });

    it('leaves sources of other languages alone', async () => {
        expect((await hinted('relation "users" does not exist', { language: L.Shell, readOnly: false })).error).toBe('relation "users" does not exist');
    });
});

describe('fixNameCase', () => {
    const schema = {
        source: 'db',
        tables: [
            {
                name: 'public.Users',
                type: 'table',
                columns: [{ name: 'CountryCode', type: 'text', nullable: true }, { name: 'Count', type: 'int', nullable: true }],
            },
            { name: 'job_states', type: 'table', columns: [{ name: 'status', type: 'text', nullable: true }] },
        ],
    };

    it.each([
        ['select count(*) from Users', 'relation "users" does not exist', 'select count(*) from "Users"'],
        ['SELECT * FROM USERS -- Users\nWHERE 1 = 1', 'relation "users" does not exist', 'SELECT * FROM "Users" -- Users\nWHERE 1 = 1'],
        [
            `SELECT * FROM "Users" u WHERE u.countrycode = 'countrycode'`,
            'column u.countrycode does not exist',
            `SELECT * FROM "Users" u WHERE u."CountryCode" = 'countrycode'`,
        ],
        ['SELECT count(*), count FROM "Users"', 'column "count" does not exist', 'SELECT count(*), "Count" FROM "Users"'],
    ])('writes the name as the schema spells it: %s', (query, error, fixed) => {
        expect(fixNameCase(query, error, schema)).toBe(fixed);
    });

    it('quotes the way the source does', () => {
        expect(fixNameCase('select * from users', "Invalid object name 'users'.", schema, (n) => `[${n}]`)).toBe('select * from [Users]');
        expect(fixNameCase('select * from users', "Table 'shop.users' doesn't exist", schema, (n) => `\`${n}\``)).toBe('select * from `Users`');
    });

    it.each([
        // No name differing only in case, a name already quoted, a hidden table, another error
        ['select * from job_states', 'relation "job_states" does not exist'],
        ['select * from "users"', 'relation "users" does not exist'],
        ['select * from onetimecodes', 'relation "onetimecodes" does not exist'],
        ['select * form Users', 'syntax error at or near "form"'],
        // Only inside a string under some dialect's reading (MySQL backslash escapes)
        ["select 'it\\' Users' from t", 'relation "users" does not exist'],
    ])('leaves other queries alone: %s', (query, error) => {
        expect(fixNameCase(query, error, schema)).toBeUndefined();
    });
});

describe('DataExplorerExecutor name case', () => {
    /** A PostgreSQL-like source: names without quotes are folded to lower case and the table is "Users". */
    function create(o: Partial<DataExplorerProviderOptions> = {}) {
        const queries: string[] = [];
        const p: IDataExplorerProvider = {
            executeAsync: async (context) => {
                queries.push(context.query);
                if (!context.query.includes('"Users"')) throw new Error('42P01: relation "users" does not exist');
                if (/countrycode/i.test(context.query) && !context.query.includes('"CountryCode"')) {
                    // Node providers answer failures in the result
                    return { ...result(null, []), success: false, error: '42703: column "countrycode" does not exist' };
                }
                return result(['n'], [[3]]);
            },
            getSchemaAsync: async () => ({
                source: 'db',
                tables: [{ name: 'public.Users', type: 'table', columns: [{ name: 'CountryCode', type: 'text', nullable: true }] }],
            }),
        };
        const registry = new DataExplorerRegistry();
        registry.register(p, opts(o));
        const audit: DataExplorerAuditEntry[] = [];
        const executor = new DataExplorerExecutor(registry, { audit: () => async (e) => void audit.push(e) });
        return { executor, queries, audit };
    }

    it('runs again with each name as the schema spells it', async () => {
        const { executor, queries, audit } = create();

        const res = await executor.executeAsync({ source: 'db', query: "select count(*) from Users where countrycode = 'MD'" });

        expect(res.error).toBeFalsy();
        expect(res.success).toBe(true);
        expect(res.executedQuery).toBe(`select count(*) from "Users" where "CountryCode" = 'MD'`);
        expect(queries).toHaveLength(3);
        await new Promise((r) => setImmediate(r));
        expect(audit).toHaveLength(1);
        expect(audit[0].metadata.query).toBe("select count(*) from Users where countrycode = 'MD'");
        expect(audit[0].metadata.executedQuery).toBe(res.executedQuery);
    });

    it('leaves a query that ran as sent alone', async () => {
        const { executor } = create();
        const res = await executor.executeAsync({ source: 'db', query: 'select count(*) from "Users"' });
        expect(res.success).toBe(true);
        expect(res.executedQuery).toBeUndefined();
    });

    it.each([
        [false, true],
        [true, false],
    ])('only hints on a writable source or when turned off (readOnly %s, fixNameCase %s)', async (readOnly, fix) => {
        const { executor, queries } = create({ readOnly, fixNameCase: fix });

        const res = await executor.executeAsync({ source: 'db', query: 'select count(*) from Users' });

        expect(res.success).toBe(false);
        expect(res.error!.endsWith('Names with capital letters need double quotes: "Users"')).toBe(true);
        expect(queries).toHaveLength(1);
    });
});

describe('masked columns', () => {
    const o = opts({ maskColumns: ['email', '*phone*'], dropColumns: ['password_hash'] });

    it('allows masked columns as plain items of the select list', () => {
        for (const q of [
            'SELECT * FROM users',
            'SELECT email FROM users',
            'SELECT DISTINCT u.email, name FROM users u',
            'SELECT TOP 5 email FROM users',
            'SELECT password_hash FROM users;',
            'SELECT * FROM phones',
            'SELECT p.number FROM phones AS p',
            'WITH x AS (SELECT 1 AS a) SELECT a FROM x',
        ]) {
            expect(maskedColumnError(o, q), q).toBeUndefined();
        }
    });

    it('refuses every other use', () => {
        for (const q of [
            'SELECT email AS e FROM users',
            'SELECT email e FROM users',
            'SELECT upper(email) FROM users',
            "SELECT email || '' FROM users",
            "SELECT id FROM users WHERE email = 'a@x.io'",
            "SELECT * FROM users u WHERE u.email LIKE 'a%'",
            'SELECT * FROM users ORDER BY email',
            'SELECT name AS email, email AS name FROM users',
            'SELECT id FROM t UNION SELECT email FROM users',
            'SELECT (SELECT email FROM users LIMIT 1)',
            "SELECT CASE WHEN home_phone LIKE '5%' THEN 1 END FROM users",
            'SELECT password_hash AS h FROM users',
            // Under the MySQL reading the # comment hides nothing: the alias counts
            'SELECT email # x\nAS e FROM users',
            `SELECT "id" FROM "users" WHERE "email" LIKE '%a%'`,
            `SELECT "id" FROM "users" u WHERE u."email" = 'x'`,
        ]) {
            expect(maskedColumnError(o, q), q).toContain('can only be selected by its own name');
        }
        expect(maskedColumnError(o, 'SELECT email AS e FROM users')).toBe("Masked column 'email' can only be selected by its own name");
    });

    it('refuses whole rows and Unicode-escaped names', () => {
        for (const q of [
            'SELECT u FROM users u',
            'SELECT row_to_json(u) FROM users AS u',
            "SELECT * FROM users WHERE users::text LIKE '%@%'",
            'WITH x AS (SELECT * FROM users) SELECT x FROM x',
        ]) {
            expect(maskedColumnError(o, q), q).toContain('is a whole row');
        }
        expect(maskedColumnError(o, 'SELECT u FROM users u')).toBe("'u' is a whole row and this source masks columns: select its columns by name");
        expect(maskedColumnError(o, 'SELECT U&"\\0065mail" AS e FROM users')).toBe(
            'This source masks columns: write names without Unicode escapes (U&"...")',
        );
    });

    it('applies to SQL sources with a mask or drop policy only', () => {
        expect(maskedColumnError(opts(), 'SELECT email AS e FROM users')).toBeUndefined();
        expect(maskedColumnError(opts({ language: L.Shell, maskColumns: ['email'] }), "db.users.find({email: 'a'})")).toBeUndefined();
    });

    it('needs the result to carry a selected masked column under its own name', () => {
        expect(maskedResultError(o, 'SELECT email FROM users', ['EMAIL'])).toBeUndefined();
        expect(maskedResultError(o, 'SELECT email FROM users FOR JSON PATH', ['JSON_F52E'])).toBeDefined();
        expect(maskedResultError(o, 'SELECT * FROM users', ['x'])).toBeUndefined();
    });
});

describe('DataExplorerExecutor', () => {
    function setup(o: Partial<DataExplorerProviderOptions>, now?: () => number) {
        const registry = new DataExplorerRegistry();
        const p = provider();
        registry.register(p.provider, opts(o));
        const audit: DataExplorerAuditEntry[] = [];
        const executor = new DataExplorerExecutor(registry, {
            audit: () => async (e) => {
                audit.push(e);
            },
            rateLimiter: new DataExplorerRateLimiter(now),
        });
        return { registry, executor, audit, ...p };
    }

    it('refuses writes on a read-only source (the default) without calling the provider', async () => {
        const { executor, executeAsync } = setup({});
        const res = await executor.executeAsync({ source: 'db', query: 'DELETE FROM users' });
        expect(res.success).toBe(false);
        expect(res.errorCode).toBe('read_only');
        expect(executeAsync).not.toHaveBeenCalled();
    });

    it('runs writes when readOnly is false', async () => {
        const { executor, executeAsync } = setup({ readOnly: false });
        expect((await executor.executeAsync({ source: 'db', query: 'DELETE FROM users' })).success).toBe(true);
        expect(executeAsync).toHaveBeenCalledOnce();
    });

    it('skips the check for providers that only read', async () => {
        const { executor, provider: p } = setup({});
        (p as any).readOnlyQueries = true;
        expect((await executor.executeAsync({ source: 'db', query: 'anything' })).success).toBe(true);
    });

    it('needs the source permissions', async () => {
        const { executor } = setup({ requiredPermissions: ['data:billing'] });
        const denied = await executor.executeAsync({ source: 'db', query: 'SELECT 1' }, { userId: 'u', hasPermission: () => false });
        expect(denied.errorCode).toBe('forbidden');
        expect(denied.error).toContain('data:billing');
        const allowed = await executor.executeAsync({ source: 'db', query: 'SELECT 1' }, { userId: 'u', hasPermission: () => true });
        expect(allowed.success).toBe(true);
        // An open server (no permission check) lets everyone in
        expect((await executor.executeAsync({ source: 'db', query: 'SELECT 1' })).success).toBe(true);
    });

    it('limits queries per caller and window', async () => {
        let t = 0;
        const { executor } = setup({ rateLimit: { maxQueries: 2, windowSeconds: 60 } }, () => t);
        const run = (userId: string) => executor.executeAsync({ source: 'db', query: 'SELECT 1' }, { userId });
        expect((await run('a')).success).toBe(true);
        expect((await run('a')).success).toBe(true);
        expect((await run('a')).errorCode).toBe('rate_limited');
        expect((await run('b')).success).toBe(true);
        t = 61_000;
        expect((await run('a')).success).toBe(true);
    });

    it('forgets callers whose window has passed once many are tracked', () => {
        let t = 0;
        const limiter = new DataExplorerRateLimiter(() => t);
        const o = opts({ rateLimit: { maxQueries: 1, windowSeconds: 1 } });
        for (let i = 0; i < 10_000; i++) limiter.tryAcquire(o, { remoteAddress: `10.0.${i >> 8}.${i & 255}` });
        t = 2_000;
        limiter.tryAcquire(o, { remoteAddress: '10.1.0.1' });
        expect((limiter as any).hits.size).toBe(1);
    });

    it('masks columns and audits every query, refusals included', async () => {
        const { executor, audit } = setup({ maskColumns: ['email'], dropColumns: ['password'] });
        const res = await executor.executeAsync({ source: 'db', query: 'SELECT * FROM users' }, { userId: 'u1', userName: 'ann', remoteAddress: '10.0.0.1' });
        expect(res.columns).toEqual(['id', 'email']);
        expect(res.rows).toEqual([[1, MASK]]);
        await executor.executeAsync({ source: 'db', query: 'DROP TABLE users' }, { userId: 'u1', userName: 'ann' });
        expect(audit).toHaveLength(2);
        expect(audit[0]).toMatchObject({
            event: 'data_query',
            userId: 'u1',
            userName: 'ann',
            metadata: { source: 'db', query: 'SELECT * FROM users', success: true, rowCount: 1, remoteAddress: '10.0.0.1' },
        });
        expect(audit[1].metadata).toMatchObject({ success: false, error: expect.stringContaining('Read-only') });
    });

    it('refuses masked columns under another name before the provider runs, and audits it', async () => {
        const { executor, audit, executeAsync } = setup({ maskColumns: ['email'] });
        const res = await executor.executeAsync({ source: 'db', query: 'SELECT email AS e FROM users' }, { userId: 'u1' });
        expect(res).toMatchObject({ success: false, errorCode: 'masked_column', error: "Masked column 'email' can only be selected by its own name" });
        expect(executeAsync).not.toHaveBeenCalled();
        expect(audit[0].metadata.error).toBe(res.error);
    });

    it('withholds rows that bring a masked column back under another name', async () => {
        const registry = new DataExplorerRegistry();
        registry.register(provider(() => result(['JSON_F52E'], [['[{"email":"a@x.io"}]']])).provider, opts({ maskColumns: ['email'] }));
        const executor = new DataExplorerExecutor(registry);
        const res = await executor.executeAsync({ source: 'db', query: 'SELECT email FROM users FOR JSON PATH' });
        expect(res).toMatchObject({ success: false, rows: [], errorCode: 'masked_column' });
    });

    it('truncates long queries in the audit and skips sources with audit: false', async () => {
        const { executor, audit } = setup({});
        await executor.executeAsync({ source: 'db', query: `SELECT '${'x'.repeat(3000)}'` });
        expect((audit[0].metadata.query as string).length).toBe(AUDIT_QUERY_MAX_LENGTH + 1);
        const quiet = setup({ audit: false });
        await quiet.executor.executeAsync({ source: 'db', query: 'SELECT 1' });
        expect(quiet.audit).toHaveLength(0);
    });

    it('lists only the sources the caller may use, with readOnly and canExport', () => {
        const registry = new DataExplorerRegistry();
        registry.register(provider().provider, opts({ name: 'open', exportPermissions: ['data:export'] }));
        registry.register(provider().provider, opts({ name: 'billing', readOnly: false, requiredPermissions: ['data:billing'] }));
        const caller = { userId: 'u', hasPermission: (p: string) => p !== 'data:billing' && p !== 'data:export' };
        const sources = registry.getSources(caller);
        expect(sources.map((s) => s.name)).toEqual(['open']);
        expect(sources[0]).toMatchObject({ readOnly: true, canExport: false });
        const all = registry.getSources();
        expect(all.find((s) => s.name === 'billing')).toMatchObject({ readOnly: false, canExport: true });
    });
});

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

describe('data explorer MCP tools', () => {
    it('apply the source permissions, read-only rules and schema filter', async () => {
        const registry = new DataExplorerRegistry();
        registry.register(provider().provider, opts({ allowedObjects: ['users'], dropColumns: ['password'] }));
        registry.register(provider().provider, opts({ name: 'billing', requiredPermissions: ['data:billing'] }));
        const executor = new DataExplorerExecutor(registry);
        const mcp = new DataExplorerMcpToolProvider(registry, executor, () => ({ userId: 'u', hasPermission: () => false }));
        const tool = (name: string) => mcp.getTools().find((t) => t.name === name)!;
        const ctx = {} as any;

        const sources = await tool('data_sources').call({}, ctx);
        expect(JSON.stringify(sources)).not.toContain('billing');
        const schema = await tool('data_schema').call({ source: 'db' }, ctx);
        expect(JSON.stringify(schema)).not.toContain('secrets');
        expect(JSON.stringify(schema)).not.toContain('password');
        const denied = await tool('data_schema').call({ source: 'billing' }, ctx);
        expect(denied.isError).toBe(true);
        const write = await tool('data_query').call({ source: 'db', query: 'DELETE FROM users' }, ctx);
        expect(write.isError).toBe(true);
        expect(JSON.stringify(write)).toContain('Read-only');
    });
});

// ---------------------------------------------------------------------------
// HTTP on a protected server
// ---------------------------------------------------------------------------

describe('data explorer routes on a protected server', () => {
    const ROOT_PASS = 'rootpass1';
    const V1 = '/api/v1/qcli';
    const DE = '/api/qcli/data-explorer';
    let cli: CliServerResult;
    let users: UsersPluginResult;
    let server: http.Server;
    let app: express.Express;
    let auditStore: InMemoryAuditStore;
    let root: string;
    let analyst: string;
    let plain: string;
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const login = async (name: string, password: string) => {
        const res = await request(app).post(`${V1}/sessions`).send({ username: name, password });
        expect(res.status).toBe(201);
        return res.body.token as string;
    };

    beforeAll(async () => {
        cli = createCliServer({
            configure: (b) => {
                b.addDataExplorerProvider(provider().provider, opts({ name: 'main', exportPermissions: ['data:export'] }));
                b.addDataExplorerProvider(
                    provider().provider,
                    opts({ name: 'billing', requiredPermissions: ['data:billing'], rateLimit: { maxQueries: 2, windowSeconds: 60 } }),
                );
            },
        });
        auditStore = new InMemoryAuditStore();
        users = new CliUsersBuilder()
            .setDefaultAdminPassword(ROOT_PASS)
            .setIpRateLimit(10_000)
            .setProtectServer(true)
            .setAuditStore(auditStore)
            .build(() => {});
        await users.ready;
        cli.mountPlugin(users);
        app = cli.app;
        server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

        root = await login('root', ROOT_PASS);
        await request(app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'analysts', permissions: ['data:query', 'data:billing'] }).expect(201);
        await request(app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'queriers', permissions: ['data:query'] }).expect(201);
        await request(app).post(`${V1}/users`).set(bearer(root)).send({ name: 'analyst', email: 'an@x.io', password: 'analystpass', groups: ['analysts'] }).expect(201);
        await request(app).post(`${V1}/users`).set(bearer(root)).send({ name: 'plain', email: 'pl@x.io', password: 'plainpass', groups: ['queriers'] }).expect(201);
        analyst = await login('analyst', 'analystpass');
        plain = await login('plain', 'plainpass');
    });

    afterAll(async () => {
        cli?.eventSocketManager.dispose();
        cli?.logSocketManager.dispose();
        users?.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    });

    it('lists only the sources a user may use, with readOnly and canExport', async () => {
        const plainSources = (await request(app).get(`${DE}/sources`).set(bearer(plain))).body;
        expect(plainSources.map((s: any) => s.name)).toEqual(['main']);
        expect(plainSources[0]).toMatchObject({ readOnly: true, canExport: false });
        const rootSources = (await request(app).get(`${DE}/sources`).set(bearer(root))).body;
        expect(rootSources.map((s: any) => s.name).sort()).toEqual(['billing', 'main']);
        expect(rootSources.find((s: any) => s.name === 'main').canExport).toBe(true);
    });

    it('answers 403 without the source permissions', async () => {
        const exec = await request(app).post(`${DE}/execute`).set(bearer(plain)).send({ source: 'billing', query: 'SELECT 1' });
        expect(exec.status).toBe(403);
        expect(exec.body.error).toContain('data:billing');
        expect((await request(app).get(`${DE}/schema?source=billing`).set(bearer(plain))).status).toBe(403);
    });

    it('refuses writes on a read-only source', async () => {
        const res = await request(app).post(`${DE}/execute`).set(bearer(plain)).send({ source: 'main', query: 'DELETE FROM users' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: false, errorCode: 'read_only' });
    });

    it('answers 429 over the rate limit', async () => {
        const run = () => request(app).post(`${DE}/execute`).set(bearer(analyst)).send({ source: 'billing', query: 'SELECT 1' });
        expect((await run()).status).toBe(200);
        expect((await run()).status).toBe(200);
        const limited = await run();
        expect(limited.status).toBe(429);
        expect(limited.body.error).toContain('Too many queries');
    });

    it('writes data_query entries to the audit log', async () => {
        await request(app).post(`${DE}/execute`).set(bearer(plain)).send({ source: 'main', query: 'SELECT 42' }).expect(200);
        const entries = await auditStore.getEntries();
        const entry = entries.find((e) => e.event === 'data_query' && (e.metadata as any)?.query === 'SELECT 42');
        expect(entry).toBeDefined();
        expect(entry).toMatchObject({ username: 'plain', details: 'main', metadata: { source: 'main', success: true } });
    });
});
