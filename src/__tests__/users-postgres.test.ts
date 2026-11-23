import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CliUsersBuilder } from '../../plugins/users/index';
import { createPostgresUsersStores, runPostgresMigrations } from '../../plugins/users-postgres';

/** Runs when QCLI_TEST_POSTGRES holds a connection string to an empty database the tests may wipe. */
const url = process.env.QCLI_TEST_POSTGRES;
const PREFIX = 'qcli_it_';
const TABLES = ['users', 'groups', 'credentials', 'sessions', 'api_tokens', 'audit', 'schema_migrations'].map((t) => PREFIX + t);
const BASE = '/api/v1/qcli';
const ROOT_PASS = 'root-pass-1234';

describe.skipIf(!url)('users plugin on PostgreSQL', () => {
    const pool = new Pool({ connectionString: url });
    const drop = () => pool.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')}, it_orders, it_orders_migrations`);

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

    it('applies the schema migrations once, and refuses a database migrated by a newer version', async () => {
        const stores = createPostgresUsersStores(pool, { tablePrefix: PREFIX });
        await Promise.all([stores.init(), stores.init()]); // two servers starting together
        const { rows } = await pool.query(`SELECT id, name FROM ${PREFIX}schema_migrations`);
        expect(rows).toHaveLength(1);
        await stores.init();
        await pool.query(`INSERT INTO ${PREFIX}schema_migrations (id, name) VALUES (99, 'from the future')`);
        await expect(stores.init()).rejects.toThrow(/migrations this version does not know \(99\)/);
    });

    it('runs a host\'s own migrations in order, each once, and rolls back a failing one', async () => {
        const migrations = [
            { id: 2, name: 'orders.created_at', up: 'ALTER TABLE it_orders ADD COLUMN created_at bigint NOT NULL DEFAULT 0' },
            { id: 1, name: 'create orders', up: 'CREATE TABLE it_orders (id text PRIMARY KEY)' },
        ];
        expect(await runPostgresMigrations(pool, 'it_orders_migrations', migrations)).toEqual([1, 2]);
        expect(await runPostgresMigrations(pool, 'it_orders_migrations', migrations)).toEqual([]);
        await expect(
            runPostgresMigrations(pool, 'it_orders_migrations', [...migrations, { id: 3, name: 'broken', up: 'ALTER TABLE nope ADD COLUMN x int' }]),
        ).rejects.toThrow(/migration 3 \(broken\) failed/);
        const { rows } = await pool.query('SELECT id FROM it_orders_migrations ORDER BY id');
        expect(rows.map((r) => r.id)).toEqual([1, 2]);
        await expect(runPostgresMigrations(pool, 'it_orders_migrations', [migrations[1], migrations[1]])).rejects.toThrow(/duplicate migration id 1/);
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
