import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CliUsersBuilder } from '../../plugins/users/index';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPostgresUsersStores } from '../../plugins/users-postgres/index';

/** Runs when QCLI_TEST_POSTGRES holds a connection string to an empty database the tests may wipe. */
const url = process.env.QCLI_TEST_POSTGRES;
const PREFIX = 'QcliIt';
const TABLES = ['Users', 'Groups', 'Credentials', 'Sessions', 'ApiTokens', 'AuditEntries', 'Migrations', 'MigrationRuns'].map((t) => `"${PREFIX}${t}"`);
/** The first version's tables (never on npm, live on plugins.qodalis.com). */
const V1 = ['qcli_users', 'qcli_groups', 'qcli_credentials', 'qcli_sessions', 'qcli_api_tokens', 'qcli_audit', 'qcli_schema_migrations'];
const BASE = '/api/v1/qcli';
const ROOT_PASS = 'root-pass-1234';

describe.skipIf(!url)('users plugin on PostgreSQL', () => {
    const pool = new Pool({ connectionString: url });
    const drop = () => pool.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')}, ${V1.join(', ')}`);

    beforeEach(drop);
    afterAll(async () => {
        await drop();
        await pool.end();
    });

    /** A server like a host would build it; a second call is the same service after a restart. */
    async function startServer() {
        const stores = createPostgresUsersStores(pool, { tablePrefix: PREFIX });
        await stores.init();
        const plugin = new CliUsersBuilder()
            .setUserStore(stores.userStore)
            .setGroupStore(stores.groupStore)
            .setCredentialStore(stores.credentialStore)
            .setSessionStore(stores.sessionStore)
            .setApiTokenStore(stores.apiTokenStore)
            .setAuditStore(stores.auditStore)
            .setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4, ipRateLimit: 10_000 })
            .build(() => undefined);
        await plugin.ready;
        const app = express();
        app.use(express.json());
        app.use(plugin.prefix, plugin.router);
        return { app, plugin, stores };
    }

    it('keeps users, groups, passwords, sessions and API tokens across a restart', async () => {
        const first = await startServer();
        const root = await request(first.app).post(`${BASE}/sessions`).send({ username: 'root', password: ROOT_PASS });
        expect(root.status).toBe(201);
        const as = { Authorization: `Bearer ${root.body.token}` };
        expect((await request(first.app).post(`${BASE}/groups`).set(as).send({ name: 'Moderators', permissions: ['marketplace:moderate'] })).status).toBe(201);
        const created = await request(first.app).post(`${BASE}/users`).set(as).send({ name: 'mo', email: 'mo@example.com', password: 'mo-pass', groups: ['Moderators'] });
        expect(created.status).toBe(201);
        const mo = await request(first.app).post(`${BASE}/sessions`).send({ username: 'mo', password: 'mo-pass' });
        expect(mo.status).toBe(201);
        const token = await request(first.app).post(`${BASE}/tokens`).set({ Authorization: `Bearer ${mo.body.token}` }).send({ name: 'ci', expiresInDays: 30 });
        expect(token.status).toBe(201);
        first.plugin.dispose();

        // the same service started again on the same database
        const second = await startServer();
        expect((await second.stores.groupStore.getGroups()).map((g) => g.name).sort()).toEqual(['Moderators', 'admin', 'users'].sort());
        expect((await second.stores.userStore.getUsers()).map((u) => u.name).sort()).toEqual(['mo', 'root']);
        // the session, the API token and the password all still work
        const me = await request(second.app).get(`${BASE}/sessions/current`).set({ Authorization: `Bearer ${mo.body.token}` });
        expect(me.status).toBe(200);
        expect(me.body.user.name).toBe('mo');
        // a token has no session: the permissions route answers for it
        const viaToken = await request(second.app).get(`${BASE}/permissions`).set({ Authorization: `Bearer ${token.body.token}` });
        expect(viaToken.status).toBe(200);
        expect((await request(second.app).get(`${BASE}/permissions`).set({ Authorization: 'Bearer qcli_pat_wrong' })).status).toBe(401);
        expect((await request(second.app).post(`${BASE}/sessions`).send({ username: 'mo', password: 'mo-pass' })).status).toBe(201);
        expect((await second.stores.auditStore.getEntries({ event: 'login' })).length).toBeGreaterThanOrEqual(3);
        second.plugin.dispose();
    });

    it('applies the schema once, also when two servers start together, recorded as qcli-users', async () => {
        const stores = createPostgresUsersStores(pool, { tablePrefix: PREFIX });
        await Promise.all([stores.init(), stores.init()]);
        const { rows } = await pool.query(`SELECT "Source", "Id" FROM "${PREFIX}Migrations"`);
        expect(rows).toEqual([{ Source: 'qcli-users', Id: '1' }]);
        await stores.init();
        const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE '${PREFIX}%' ORDER BY table_name`);
        expect(tables.rows.map((r) => r.table_name)).toEqual(
            ['ApiTokens', 'AuditEntries', 'Credentials', 'Groups', 'MigrationRuns', 'Migrations', 'Sessions', 'Users'].map((t) => PREFIX + t),
        );
    });

    it('adopts the first version\'s qcli_* tables with their data: renamed tables, columns and indexes', async () => {
        await pool.query(readFileSync(join(__dirname, 'fixtures/users-postgres-v1.sql'), 'utf8'));
        await pool.query('CREATE TABLE qcli_schema_migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
        await pool.query("INSERT INTO qcli_schema_migrations (id, name) VALUES (1, 'users, groups, credentials, sessions, api tokens, audit')");
        await pool.query(
            `INSERT INTO qcli_users (id, name, email, groups, created_at, updated_at) VALUES ('u1', 'mo', 'mo@example.com', '["admin"]', 1, 2)`,
        );
        await pool.query(`INSERT INTO qcli_audit (id, timestamp, event, username, entry) VALUES ('a1', 5, 'login', 'mo', '{"event":"login"}')`);

        const stores = createPostgresUsersStores(pool, { tablePrefix: PREFIX });
        await stores.init();
        expect(await stores.userStore.getUser('mo')).toMatchObject({ id: 'u1', email: 'mo@example.com', groups: ['admin'] });
        expect(await stores.auditStore.getEntries()).toEqual([{ event: 'login' }]);
        const left = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'qcli\\_%'`);
        expect(left.rows).toEqual([]);
        const indexes = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = '${PREFIX}Users' ORDER BY indexname`);
        expect(indexes.rows.map((r) => r.indexname)).toEqual([`IX_${PREFIX}Users_Email`, `IX_${PREFIX}Users_Name`, `PK_${PREFIX}Users`]);
        // names stay unique ignoring case after the move
        await expect(stores.userStore.createUser({ name: 'MO', email: 'x@example.com' })).rejects.toThrow();
    });

    it('stores API tokens with audience, permissions and expiry, found by hash', async () => {
        const { apiTokenStore } = createPostgresUsersStores(pool, { tablePrefix: PREFIX });
        await createPostgresUsersStores(pool, { tablePrefix: PREFIX }).init();
        const base = { userId: 'u1', name: 'ci', createdAt: 1000, expiresAt: null };
        await apiTokenStore.createToken({ ...base, id: 't1', tokenHash: 'h1', audience: 'host', permissions: ['rates:read'] });
        await apiTokenStore.createToken({ ...base, id: 't2', tokenHash: 'h2', expiresAt: 5000 });
        await apiTokenStore.createToken({ ...base, id: 't3', tokenHash: 'h3', userId: 'u2' });
        expect(await apiTokenStore.getTokenByHash('h1')).toEqual({ ...base, id: 't1', tokenHash: 'h1', audience: 'host', permissions: ['rates:read'] });
        expect(await apiTokenStore.getToken('t2')).toEqual({ ...base, id: 't2', tokenHash: 'h2', expiresAt: 5000 });
        expect((await apiTokenStore.getTokens('u1')).map((t) => t.id)).toEqual(['t1', 't2']);
        expect(await apiTokenStore.getTokens()).toHaveLength(3);
        await apiTokenStore.updateLastUsed('t1', 7000);
        expect((await apiTokenStore.getToken('t1'))!.lastUsedAt).toBe(7000);
        await apiTokenStore.deleteToken('t1');
        expect(await apiTokenStore.getTokenByHash('h1')).toBeUndefined();
        await apiTokenStore.deleteUserTokens('u1');
        expect((await apiTokenStore.getTokens()).map((t) => t.id)).toEqual(['t3']);
    });
});
