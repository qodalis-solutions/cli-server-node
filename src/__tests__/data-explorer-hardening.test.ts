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
