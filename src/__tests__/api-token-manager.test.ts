/**
 * `usersPlugin.apiTokens` (ApiTokenManager): tokens a host creates, lists and revokes
 * for its users, with the HTTP routes' validation, limits, audit and events, plus
 * `host`-audience tokens limited to the host's catalog entries.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { ICliEventBus } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersModuleOptions, UsersPluginResult, hashToken } from '../../plugins/users/index';
import { BASE, ROOT_PASS, auth, login } from './users-test-helpers';

const DAY = 24 * 60 * 60 * 1000;

let plugins: UsersPluginResult[] = [];

afterEach(() => {
    for (const p of plugins) p.dispose();
    plugins = [];
});

interface Harness {
    cli: CliServerResult;
    plugin: UsersPluginResult;
    publish: ReturnType<typeof vi.fn>;
    /** Creates a user in the given groups (created with these permissions) and returns its id. */
    addUser(name: string, permissions: string[], extra?: { disabled?: boolean }): Promise<string>;
}

async function start(options: UsersModuleOptions = {}): Promise<Harness> {
    const cli = createCliServer({});
    cli.builder.addPermissions([
        { name: 'rates:read', description: 'Official exchange rates', group: 'Rates' },
        { name: 'banks:read', description: 'Banks and their buy and sell rates', group: 'Rates' },
    ]);
    const publish = vi.fn(async () => undefined);
    const bus: ICliEventBus = { publish, subscribe: () => () => undefined };
    const plugin = new CliUsersBuilder()
        .setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4, ipRateLimit: 10_000, ...options })
        .build(bus);
    plugins.push(plugin);
    cli.mountPlugin(plugin);
    await plugin.ready;
    let n = 0;
    return {
        cli,
        plugin,
        publish,
        addUser: async (name, permissions, extra = {}) => {
            const group = `g${n++}`;
            await plugin.groupStore.createGroup({ name: group, permissions });
            const user = await plugin.userStore.createUser({ name, email: `${name}@example.com`, groups: [group], ...extra });
            return user.id;
        },
    };
}

describe('ApiTokenManager: create', () => {
    it('creates a cli token like POST /tokens: { token, apiToken }, audit, event', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['commands:execute', 'files:read']);
        const before = Date.now();
        const created = await h.plugin.apiTokens.create(id, { name: 'ci', permissions: ['files:read'] });
        expect(created.token).toMatch(/^qcli_pat_[A-Za-z0-9_-]{43}$/);
        expect(created.apiToken).toMatchObject({ name: 'ci', userId: id, userName: 'alice', lastUsedAt: null, audience: 'cli', permissions: ['files:read'] });
        expect(Object.keys(created.apiToken)).toEqual(['id', 'name', 'userId', 'userName', 'createdAt', 'expiresAt', 'lastUsedAt', 'audience', 'permissions']);
        expect(created.apiToken.expiresAt).toBeGreaterThanOrEqual(before + 90 * DAY);
        const stored = await h.plugin.apiTokenStore.getToken(created.apiToken.id);
        expect(stored!.tokenHash).toBe(hashToken(created.token));
        expect(stored!.audience).toBe('cli');

        const audit = (await h.plugin.auditStore.getEntries()).find((e) => e.event === 'token_created');
        expect(audit).toMatchObject({ username: 'alice', userId: id, actor: 'alice', details: `ci (${created.apiToken.id})` });
        expect(h.publish).toHaveBeenCalledWith(
            'token:created',
            { tokenId: created.apiToken.id, name: 'ci', userId: id, actor: 'alice' },
            { permission: 'tokens:read', userId: id },
        );

        // the token works on the CLI routes
        const res = await request(h.cli.app).get(`${BASE}/permissions`).set(auth(created.token));
        expect(res.status).toBe(200);
        expect(res.body.map((p: { name: string }) => p.name)).toEqual(['files:read']);
    });

    it('audits with the given actor', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['rates:read']);
        await h.plugin.apiTokens.create(id, { name: 'rates', audience: 'host', permissions: ['rates:read'], actor: 'ratebell' });
        const audit = (await h.plugin.auditStore.getEntries()).find((e) => e.event === 'token_created');
        expect(audit).toMatchObject({ username: 'alice', userId: id, actor: 'ratebell' });
    });

    it('creates a host token with host-surface permissions the user holds', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['rates:read', 'banks:read', 'files:read']);
        const created = await h.plugin.apiTokens.create(id, { name: 'api', audience: 'host', permissions: ['rates:read', 'banks:read'] });
        expect(created.apiToken.audience).toBe('host');
        expect(created.apiToken.permissions).toEqual(['rates:read', 'banks:read']);
        expect((await h.plugin.apiTokenStore.getToken(created.apiToken.id))!.audience).toBe('host');
    });

    it('CreateHost_NormalizesCase: entries are stored with the catalog spelling', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['rates:read']);
        const created = await h.plugin.apiTokens.create(id, { name: 'api', audience: 'host', permissions: ['RATES:READ'] });
        expect(created.apiToken.permissions).toEqual(['rates:read']);
    });

    it('CreateHost_HeldThroughWildcard: a user holding rates:* and banks:* may grant both', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['rates:*', 'banks:*']);
        const created = await h.plugin.apiTokens.create(id, { name: 'api', audience: 'host', permissions: ['rates:read', 'banks:read'] });
        expect(created.apiToken.permissions).toEqual(['rates:read', 'banks:read']);
        const admin = await h.addUser('admin2', ['*']);
        expect((await h.plugin.apiTokens.create(admin, { name: 'all', audience: 'host', permissions: ['banks:read'] })).apiToken.permissions).toEqual([
            'banks:read',
        ]);
    });

    it('host tokens: permissions required, host-surface catalog entries only, never wildcards', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['*']);
        const create = (permissions: string[] | null | undefined) =>
            h.plugin.apiTokens.create(id, { name: 'api', audience: 'host', permissions });
        await expect(create(undefined)).rejects.toMatchObject({ status: 400, message: 'host tokens need permissions' });
        await expect(create(null)).rejects.toMatchObject({ status: 400, message: 'host tokens need permissions' });
        await expect(create([])).rejects.toMatchObject({ status: 400, message: 'host tokens need permissions' });
        await expect(create(['files:read'])).rejects.toMatchObject({ status: 400, message: 'not a host permission: files:read' });
        await expect(create(['rates:*'])).rejects.toMatchObject({ status: 400, message: 'not a host permission: rates:*' });
        await expect(create(['*'])).rejects.toMatchObject({ status: 400, message: 'not a host permission: *' });
        await expect(create(['unknown:read'])).rejects.toMatchObject({ status: 400, message: 'not a host permission: unknown:read' });
        await expect(create(['bad perm'])).rejects.toMatchObject({ status: 400, message: 'invalid permission: bad perm' });
        expect(await h.plugin.apiTokenStore.getTokens(id)).toEqual([]);
    });

    it('cli tokens keep accepting unknown and wildcard entries', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['*']);
        const created = await h.plugin.apiTokens.create(id, { name: 'any', permissions: ['custom:thing', 'rates:*'] });
        expect(created.apiToken.permissions).toEqual(['custom:thing', 'rates:*']);
        const unscoped = await h.plugin.apiTokens.create(id, { name: 'all' });
        expect(unscoped.apiToken.permissions).toBeUndefined();
    });

    it('each entry must be held by the user (403)', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['rates:read']);
        await expect(h.plugin.apiTokens.create(id, { name: 'api', audience: 'host', permissions: ['rates:read', 'banks:read'] })).rejects.toMatchObject({
            status: 403,
            message: 'forbidden: cannot grant banks:read',
        });
        // a user holding only rates:* cannot grant banks:read
        const wild = await h.addUser('bob', ['rates:*']);
        await expect(h.plugin.apiTokens.create(wild, { name: 'api', audience: 'host', permissions: ['banks:read'] })).rejects.toMatchObject({
            status: 403,
            message: 'forbidden: cannot grant banks:read',
        });
        await expect(h.plugin.apiTokens.create(id, { name: 'x', permissions: ['files:read'] })).rejects.toMatchObject({
            status: 403,
            message: 'forbidden: cannot grant files:read',
        });
    });

    it('user missing → 404, disabled → 403, bad audience → 400', async () => {
        const h = await start();
        await expect(h.plugin.apiTokens.create('nope', { name: 'x' })).rejects.toMatchObject({ status: 404, message: 'user not found' });
        // users are looked up by id only
        await h.addUser('carol', ['*']);
        await expect(h.plugin.apiTokens.create('carol', { name: 'x' })).rejects.toMatchObject({ status: 404, message: 'user not found' });
        const disabled = await h.addUser('dave', ['*'], { disabled: true });
        await expect(h.plugin.apiTokens.create(disabled, { name: 'x' })).rejects.toMatchObject({ status: 403, message: 'account disabled' });
        const id = await h.addUser('alice', ['*']);
        for (const audience of ['api', 'HOST', '', null, 1]) {
            await expect(h.plugin.apiTokens.create(id, { name: 'x', audience: audience as any })).rejects.toMatchObject({
                status: 400,
                message: 'audience must be cli or host',
            });
        }
        // the user check comes first, then the audience
        await expect(h.plugin.apiTokens.create('nope', { name: 'x', audience: 'api' as any })).rejects.toMatchObject({ status: 404 });
    });

    it('name and expiry as POST /tokens', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['*']);
        for (const name of ['', 'x'.repeat(65), 'bad/name', 12, undefined]) {
            await expect(h.plugin.apiTokens.create(id, { name: name as any })).rejects.toMatchObject({
                status: 400,
                message: 'name must be 1-64 characters of [A-Za-z0-9._ -]',
            });
        }
        for (const expiresInDays of [0, 366, 1.5, '30' as any, -1]) {
            await expect(h.plugin.apiTokens.create(id, { name: 't', expiresInDays })).rejects.toMatchObject({
                status: 400,
                message: 'expiresInDays must be an integer between 1 and 365',
            });
        }
        const one = await h.plugin.apiTokens.create(id, { name: 'one', expiresInDays: 1 });
        expect(one.apiToken.expiresAt! - one.apiToken.createdAt).toBe(DAY);
        await expect(h.plugin.apiTokens.create(id, { name: 'never', neverExpires: true })).rejects.toMatchObject({
            status: 400,
            message: 'non-expiring tokens are not allowed',
        });
        await expect(h.plugin.apiTokens.create(id, { name: 'both', neverExpires: true, expiresInDays: 5 })).rejects.toMatchObject({
            status: 400,
            message: 'expiresInDays and neverExpires cannot both be set',
        });
        // neverExpires: false is the default
        expect((await h.plugin.apiTokens.create(id, { name: 'f', neverExpires: false, expiresInDays: 2 })).apiToken.expiresAt).not.toBeNull();
    });

    it('neverExpires with allowNonExpiringTokens', async () => {
        const h = await start({ allowNonExpiringTokens: true });
        const id = await h.addUser('alice', ['*']);
        const never = await h.plugin.apiTokens.create(id, { name: 'never', neverExpires: true });
        expect(never.apiToken.expiresAt).toBeNull();
        await expect(h.plugin.apiTokens.create(id, { name: 'both', neverExpires: true, expiresInDays: 5 })).rejects.toMatchObject({
            status: 400,
            message: 'expiresInDays and neverExpires cannot both be set',
        });
    });

    it('duplicate names (409) and the 20-token limit count both audiences', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['*']);
        await h.plugin.apiTokens.create(id, { name: 'Rates', audience: 'host', permissions: ['rates:read'] });
        await expect(h.plugin.apiTokens.create(id, { name: 'rates' })).rejects.toMatchObject({ status: 409, message: "token 'rates' already exists" });
        for (let i = 1; i < 20; i++) {
            await h.plugin.apiTokens.create(id, { name: `t${i}`, ...(i % 2 ? { audience: 'host' as const, permissions: ['banks:read'] } : {}) });
        }
        await expect(h.plugin.apiTokens.create(id, { name: 't20' })).rejects.toMatchObject({
            status: 400,
            message: 'a user may have at most 20 tokens',
        });
        await expect(h.plugin.apiTokens.create(id, { name: 't21', audience: 'host', permissions: ['rates:read'] })).rejects.toMatchObject({
            status: 400,
            message: 'a user may have at most 20 tokens',
        });
    });

    it('external auth without API tokens → 501', async () => {
        const h = await start({ authAdapter: () => null });
        const id = await h.addUser('alice', ['*']);
        await expect(h.plugin.apiTokens.create(id, { name: 'x' })).rejects.toMatchObject({
            status: 501,
            message: 'Authentication is managed by the host application',
        });
        await expect(h.plugin.apiTokens.create('nope', { name: 'x' })).rejects.toMatchObject({ status: 501 });

        const allowed = await start({ authAdapter: () => null, apiTokensWithExternalAuth: true });
        const bob = await allowed.addUser('bob', ['rates:read']);
        const created = await allowed.plugin.apiTokens.create(bob, { name: 'x', audience: 'host', permissions: ['rates:read'] });
        expect(created.apiToken.audience).toBe('host');
    });

    it('POST /tokens still answers through the same path (cli audience, session only)', async () => {
        const h = await start();
        const root = await login(h.cli.app, 'root', ROOT_PASS);
        const res = await request(h.cli.app).post(`${BASE}/tokens`).set(auth(root.token)).send({ name: 'web', expiresInDays: null });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'non-expiring tokens are not allowed' });
        const ok = await request(h.cli.app).post(`${BASE}/tokens`).set(auth(root.token)).send({ name: 'web' });
        expect(ok.status).toBe(201);
        expect(ok.body.apiToken.audience).toBe('cli');
        const minted = await request(h.cli.app).post(`${BASE}/tokens`).set(auth(ok.body.token)).send({ name: 'x' });
        expect(minted.status).toBe(403);
        expect(minted.body).toEqual({ error: 'forbidden: API tokens cannot create tokens' });
    });
});

describe('ApiTokenManager: list and revoke', () => {
    it('lists the user tokens, oldest first, both audiences; unknown user → []', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['*']);
        const other = await h.addUser('bob', ['*']);
        const a = await h.plugin.apiTokens.create(id, { name: 'a' });
        await new Promise((r) => setTimeout(r, 5));
        const b = await h.plugin.apiTokens.create(id, { name: 'b', audience: 'host', permissions: ['rates:read'] });
        await h.plugin.apiTokens.create(other, { name: 'c' });
        const list = await h.plugin.apiTokens.list(id);
        expect(list.map((t) => t.id)).toEqual([a.apiToken.id, b.apiToken.id]);
        expect(list.map((t) => t.audience)).toEqual(['cli', 'host']);
        expect(list[1]).toEqual(b.apiToken);
        expect(await h.plugin.apiTokens.list('nope')).toEqual([]);
    });

    it('revokes: false for unknown tokens and other users tokens; true, audit and event otherwise', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['*']);
        const other = await h.addUser('bob', ['*']);
        const t = await h.plugin.apiTokens.create(id, { name: 'a', audience: 'host', permissions: ['rates:read'] });
        const bobs = await h.plugin.apiTokens.create(other, { name: 'b' });
        expect(await h.plugin.apiTokens.revoke(id, 'nope')).toBe(false);
        expect(await h.plugin.apiTokens.revoke(id, bobs.apiToken.id)).toBe(false);
        expect(await h.plugin.apiTokenStore.getToken(bobs.apiToken.id)).toBeDefined();

        expect(await h.plugin.apiTokens.revoke(id, t.apiToken.id)).toBe(true);
        expect(await h.plugin.apiTokenStore.getToken(t.apiToken.id)).toBeUndefined();
        const audit = (await h.plugin.auditStore.getEntries()).find((e) => e.event === 'token_revoked');
        expect(audit).toMatchObject({ username: 'alice', userId: id, actor: 'alice', details: `a (${t.apiToken.id})` });
        expect(h.publish).toHaveBeenCalledWith(
            'token:revoked',
            { tokenId: t.apiToken.id, name: 'a', userId: id, actor: 'alice' },
            { permission: 'tokens:read', userId: id },
        );
        expect(await h.plugin.apiTokens.revoke(id, t.apiToken.id)).toBe(false);

        expect(await h.plugin.apiTokens.revoke(other, bobs.apiToken.id, 'ratebell')).toBe(true);
        const byHost = (await h.plugin.auditStore.getEntries()).filter((e) => e.event === 'token_revoked').find((e) => e.userId === other);
        expect(byHost).toMatchObject({ username: 'bob', actor: 'ratebell' });
    });

    it('revoking a token that already expired returns true and is audited', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['*']);
        const t = await h.plugin.apiTokens.create(id, { name: 'short', expiresInDays: 1 });
        const later = Date.now() + 2 * DAY;
        const now = vi.spyOn(Date, 'now').mockReturnValue(later);
        try {
            expect((await request(h.cli.app).get(`${BASE}/permissions`).set(auth(t.token))).status).toBe(401);
            expect(await h.plugin.apiTokens.revoke(id, t.apiToken.id)).toBe(true);
        } finally {
            now.mockRestore();
        }
        expect(await h.plugin.apiTokenStore.getToken(t.apiToken.id)).toBeUndefined();
        const audit = (await h.plugin.auditStore.getEntries()).find((e) => e.event === 'token_revoked');
        expect(audit).toMatchObject({ username: 'alice', userId: id, actor: 'alice', details: `short (${t.apiToken.id})` });
        expect(h.publish).toHaveBeenCalledWith('token:revoked', expect.objectContaining({ tokenId: t.apiToken.id }), expect.anything());
    });

    it('a revoked token stops authenticating', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['*']);
        const t = await h.plugin.apiTokens.create(id, { name: 'a' });
        expect((await request(h.cli.app).get(`${BASE}/permissions`).set(auth(t.token))).status).toBe(200);
        await h.plugin.apiTokens.revoke(id, t.apiToken.id);
        expect((await request(h.cli.app).get(`${BASE}/permissions`).set(auth(t.token))).status).toBe(401);
    });
});

describe('ApiTokenManager: grantable permissions', () => {
    it('cli: every catalog entry the user holds; host: the host-surface ones', async () => {
        const h = await start();
        const id = await h.addUser('alice', ['files:read', 'rates:*']);
        expect((await h.plugin.apiTokens.grantablePermissions(id)).map((p) => p.name)).toEqual(['files:read', 'rates:read']);
        expect((await h.plugin.apiTokens.grantablePermissions(id, 'cli')).map((p) => p.name)).toEqual(['files:read', 'rates:read']);
        const host = await h.plugin.apiTokens.grantablePermissions(id, 'host');
        expect(host).toEqual([{ name: 'rates:read', description: 'Official exchange rates', group: 'Rates', surface: 'host' }]);
        const admin = await h.addUser('admin2', ['*']);
        expect((await h.plugin.apiTokens.grantablePermissions(admin, 'host')).map((p) => p.name)).toEqual(['rates:read', 'banks:read']);
        expect(await h.plugin.apiTokens.grantablePermissions(admin)).toHaveLength(27);
    });

    it('unknown user → 404; bad audience → 400', async () => {
        const h = await start();
        await expect(h.plugin.apiTokens.grantablePermissions('nope')).rejects.toMatchObject({ status: 404, message: 'user not found' });
        const id = await h.addUser('alice', ['*']);
        await expect(h.plugin.apiTokens.grantablePermissions(id, 'api' as any)).rejects.toMatchObject({
            status: 400,
            message: 'audience must be cli or host',
        });
    });
});
