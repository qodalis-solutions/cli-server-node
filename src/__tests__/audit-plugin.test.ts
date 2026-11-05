/**
 * The audit plugin (`@qodalis/cli-server-plugin-audit`): on its own, added by the
 * users plugin, its store set on either side, its API and the route policy
 * protecting it (mirrors cli-server-dotnet 1.0.0-beta.16).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AuditEntry, ICliAuditStore, pruneAudit as abstractionsPruneAudit } from '@qodalis/cli-server-abstractions';
import {
    AUDIT_CLEARED_EVENT,
    AUDIT_PLUGIN_ID,
    CliAuditBuilder,
    DEFAULT_AUDIT_LIMIT,
    InMemoryAuditStore,
    MAX_AUDIT_LIMIT,
    pruneAudit,
} from '@qodalis/cli-server-plugin-audit';
import * as usersPackage from '../../plugins/users/index';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { requiredServerPermissions } from '../auth/cli-server-auth-gate';
import { CliCommandRegistry } from '../services';
import { auth, createGroup, createUser, login } from './users-test-helpers';

const AUDIT = '/api/v1/qcli/audit';
const ROOT_PASS = 'admin123';

const disposables: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
});

function track(cli: CliServerResult, users?: UsersPluginResult): void {
    disposables.push(() => {
        users?.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
}

function usersBuilder(): CliUsersBuilder {
    return new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setMinPasswordLength(4).setIpRateLimit(10_000);
}

/** A server with the audit plugin alone (no auth provider). */
function auditOnlyServer(store: ICliAuditStore = new InMemoryAuditStore(5000)) {
    const cli = createCliServer();
    track(cli);
    const plugin = new CliAuditBuilder().setStore(store).build();
    cli.mountPlugin(plugin);
    return { cli, plugin, store };
}

/** A protected server with the users plugin (which adds the audit plugin). */
async function protectedServer(configure: (b: CliUsersBuilder) => CliUsersBuilder = (b) => b) {
    const cli = createCliServer();
    const users = configure(usersBuilder()).build((msg) => cli.eventSocketManager.broadcastMessage(msg));
    track(cli, users);
    await users.ready;
    cli.mountPlugin(users);
    const root = await login(cli.app as express.Express, 'root', ROOT_PASS);
    return { cli, users, root };
}

describe('audit plugin on its own', () => {
    it('builds with an in-memory store, its prefix and its package', () => {
        const plugin = new CliAuditBuilder().build();
        expect(plugin.prefix).toBe(AUDIT);
        expect(plugin.store).toBeInstanceOf(InMemoryAuditStore);
        expect(plugin.installedPlugin).toMatchObject({ id: AUDIT_PLUGIN_ID, name: 'Audit' });
        expect(plugin.installedPlugin.version).toBe(require('../../plugins/audit/package.json').version);
    });

    it('serves the log a host records in its store, and lists itself as installed', async () => {
        const { cli, plugin } = auditOnlyServer();
        await plugin.store.log({ timestamp: 1, event: 'plan_changed', username: 'alice', actor: 'root', properties: { to: 'pro' } });

        const res = await request(cli.app).get(AUDIT);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({ event: 'plan_changed', username: 'alice', actor: 'root', properties: { to: 'pro' } });
        expect(typeof res.body[0].id).toBe('string');
        expect(cli.builder.installedPlugins.map((p) => p.id)).toContain(AUDIT_PLUGIN_ID);
    });

    it('the contract comes from the abstractions; the users package keeps re-exporting it', () => {
        expect(pruneAudit).toBe(abstractionsPruneAudit);
        expect(usersPackage.pruneAudit).toBe(abstractionsPruneAudit);
        expect(usersPackage.InMemoryAuditStore).toBe(InMemoryAuditStore);
        expect(usersPackage.CliAuditBuilder).toBe(CliAuditBuilder);
    });
});

describe('audit API', () => {
    async function seeded(count: number) {
        const server = auditOnlyServer();
        for (let i = 0; i < count; i++) {
            await server.store.log({ timestamp: i, event: i % 2 ? 'note' : 'other', username: `u${i}`, actor: i % 3 ? 'bob' : 'Alice' });
        }
        return server;
    }

    it(`returns the newest ${DEFAULT_AUDIT_LIMIT} without a limit and never more than ${MAX_AUDIT_LIMIT}`, async () => {
        const { cli } = await seeded(MAX_AUDIT_LIMIT + 5);

        const page = await request(cli.app).get(AUDIT);
        expect(page.body).toHaveLength(DEFAULT_AUDIT_LIMIT);
        expect(page.body[0].username).toBe(`u${MAX_AUDIT_LIMIT + 4}`);

        expect((await request(cli.app).get(`${AUDIT}?limit=5000`)).body).toHaveLength(MAX_AUDIT_LIMIT);
        expect((await request(cli.app).get(`${AUDIT}?limit=3`)).body).toHaveLength(3);
        expect((await request(cli.app).get(`${AUDIT}?limit=0`)).body).toEqual([]);
    });

    it('filters by event, username and actor: exact and case-insensitive', async () => {
        const { cli } = await seeded(40);

        const one = await request(cli.app).get(`${AUDIT}?event=NOTE&username=U3`);
        expect(one.body.map((e: AuditEntry) => e.username)).toEqual(['u3']);

        const byActor = await request(cli.app).get(`${AUDIT}?actor=alice&limit=1000`);
        expect(byActor.body.length).toBeGreaterThan(0);
        expect(byActor.body.every((e: AuditEntry) => e.actor === 'Alice')).toBe(true);

        expect((await request(cli.app).get(`${AUDIT}?event=not`)).body).toEqual([]);
    });

    it('pages with offset, newest first', async () => {
        const { cli } = await seeded(10);
        const res = await request(cli.app).get(`${AUDIT}?offset=2&limit=3`);
        expect(res.body.map((e: AuditEntry) => e.username)).toEqual(['u7', 'u6', 'u5']);
    });

    it('answers 400 {error} for a negative or non-integer limit or offset', async () => {
        const { cli } = await seeded(3);
        for (const query of ['limit=-1', 'offset=-1', 'limit=abc', 'offset=x', 'limit=1.5', 'offset=2e3']) {
            const res = await request(cli.app).get(`${AUDIT}?${query}`);
            expect(res.status, query).toBe(400);
            expect(res.body, query).toEqual({ error: 'limit and offset must be integers >= 0' });
        }
    });

    it('DELETE clears the log and records audit_cleared (no caller on an open server)', async () => {
        const { cli, store } = await seeded(5);
        expect((await request(cli.app).delete(AUDIT)).status).toBe(204);
        const entries = await store.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ event: AUDIT_CLEARED_EVENT, username: '', details: 'audit log cleared' });
        expect(entries[0].actor).toBeUndefined();
    });

    it('DELETE records who cleared the log on a protected server', async () => {
        const { cli, users, root } = await protectedServer();
        expect((await request(cli.app).delete(AUDIT).set(auth(root.token))).status).toBe(204);

        const entries = await users.auditStore.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            event: AUDIT_CLEARED_EVENT,
            username: 'root',
            userId: root.userId,
            actor: 'root',
            actorId: root.userId,
        });
        expect(entries[0].metadata?.sessionId).toBe(root.sessionId);
        expect(entries[0].metadata?.remoteAddress).toBeTruthy();
    });
});

describe('users plugin adds the audit plugin', () => {
    it('builds one, records its events there, serves it and lists it after itself', async () => {
        const { cli, users, root } = await protectedServer();

        expect(users.auditPlugin.store).toBe(users.auditStore);
        expect(users.installedPlugins.map((p) => p.id)).toEqual([AUDIT_PLUGIN_ID]);
        const ids = cli.builder.installedPlugins.map((p) => p.id);
        expect(ids.indexOf(AUDIT_PLUGIN_ID)).toBe(ids.indexOf('@qodalis/cli-server-plugin-users') + 1);

        const res = await request(cli.app).get(`${AUDIT}?event=login`).set(auth(root.token));
        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({ event: 'login', username: 'root' });
    });

    it('keeps the audit API when the host mounts the users router itself', async () => {
        const users = usersBuilder().build();
        disposables.push(() => users.dispose());
        await users.ready;
        const app = express();
        app.use(users.prefix, users.router);
        const root = await login(app, 'root', ROOT_PASS);

        expect((await request(app).get(AUDIT).set(auth(root.token))).status).toBe(200);
        expect((await request(app).get(AUDIT)).status).toBe(401);
    });
});

describe('audit store set on either side', () => {
    it('setAuditStore on the users builder is the audit plugin store', async () => {
        const store = new InMemoryAuditStore();
        const { cli, users, root } = await protectedServer((b) => b.setAuditStore(store));

        expect(users.auditPlugin.store).toBe(store);
        expect(users.auditStore).toBe(store);
        expect((await store.getEntries({ event: 'login' })).length).toBe(1);
        expect((await request(cli.app).get(`${AUDIT}?event=login`).set(auth(root.token))).body).toHaveLength(1);
    });

    it('the auditStore option (setOptions) works the same', () => {
        const store = new InMemoryAuditStore();
        const users = usersBuilder().setOptions({ auditStore: store }).build();
        disposables.push(() => users.dispose());
        expect(users.auditPlugin.store).toBe(store);
    });

    it("the host's audit plugin with its own store, mounted before or after the users plugin", async () => {
        for (const auditFirst of [true, false]) {
            const store = new InMemoryAuditStore();
            const audit = new CliAuditBuilder().setStore(store).build();
            const cli = createCliServer();
            const users = usersBuilder().setAuditPlugin(audit).build();
            track(cli, users);
            await users.ready;
            if (auditFirst) cli.mountPlugin(audit);
            cli.mountPlugin(users);
            if (!auditFirst) cli.mountPlugin(audit);
            const root = await login(cli.app as express.Express, 'root', ROOT_PASS);

            expect(users.auditPlugin).toBe(audit);
            expect(users.auditStore).toBe(store);
            expect((await store.getEntries({ event: 'login' })).length).toBe(1);
            const res = await request(cli.app).get(`${AUDIT}?event=login`).set(auth(root.token));
            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(1);
            expect(cli.builder.installedPlugins.filter((p) => p.id === AUDIT_PLUGIN_ID)).toHaveLength(1);
        }
    });

    it('refuses an audit store and an audit plugin that disagree', () => {
        const audit = new CliAuditBuilder().build();
        expect(() => usersBuilder().setAuditPlugin(audit).setAuditStore(new InMemoryAuditStore()).build()).toThrow(/disagree/);
        const same = usersBuilder().setAuditPlugin(audit).setAuditStore(audit.store).build();
        disposables.push(() => same.dispose());
        expect(same.auditStore).toBe(audit.store);
    });
});

describe('audit route permissions', () => {
    const options = { cliPrefixes: ['/api/qcli', '/api/v1/qcli'], registry: new CliCommandRegistry(), publicRoutes: new Set<string>() };

    it('maps GET to audit:read and DELETE to audit:clear', () => {
        expect(requiredServerPermissions('GET', AUDIT, undefined, options as never)).toEqual(['audit:read']);
        expect(requiredServerPermissions('GET', `${AUDIT}/x`, undefined, options as never)).toEqual(['audit:read']);
        expect(requiredServerPermissions('DELETE', AUDIT, undefined, options as never)).toEqual(['audit:clear']);
        expect(requiredServerPermissions('GET', '/api/v1/qcli/auditing', undefined, options as never)).toEqual([]);
    });

    it('the users plugin no longer authenticates the audit routes itself', async () => {
        const users = usersBuilder().build();
        disposables.push(() => users.dispose());
        expect(users.serverAuth.handlesPath(AUDIT, 'GET')).toBe(false);
        expect(users.serverAuth.handlesPath('/api/v1/qcli/users', 'GET')).toBe(true);
    });

    it('a protected server requires audit:read to read and audit:clear to clear', async () => {
        const { cli, root } = await protectedServer();
        const app = cli.app as express.Express;
        await createGroup(app, root.token, { name: 'readers', permissions: ['audit:read'] });
        await createUser(app, root.token, { name: 'reader', email: 'reader@x.com', password: 'readpass', groups: ['readers'] });
        await createUser(app, root.token, { name: 'plain', email: 'plain@x.com', password: 'plainpass', groups: [] });
        const reader = (await login(app, 'reader', 'readpass')).token;
        const plain = (await login(app, 'plain', 'plainpass')).token;

        expect((await request(app).get(AUDIT)).status).toBe(401);
        expect((await request(app).get(AUDIT).set(auth(reader))).status).toBe(200);
        const denied = await request(app).delete(AUDIT).set(auth(reader));
        expect(denied.status).toBe(403);
        expect(denied.body.error).toContain('audit:clear');
        expect((await request(app).get(AUDIT).set(auth(plain))).status).toBe(403);
        expect((await request(app).delete(AUDIT).set(auth(root.token))).status).toBe(204);
    });

    it("protects the host's own audit plugin mounted on a protected server", async () => {
        const audit = new CliAuditBuilder().build();
        const cli = createCliServer();
        const users = usersBuilder().setAuditPlugin(audit).build();
        track(cli, users);
        await users.ready;
        cli.mountPlugin(audit); // first: answers before the users router
        cli.mountPlugin(users);

        expect((await request(cli.app).get(AUDIT)).status).toBe(401);
        const root = await login(cli.app as express.Express, 'root', ROOT_PASS);
        expect((await request(cli.app).get(AUDIT).set(auth(root.token))).status).toBe(200);
    });
});
