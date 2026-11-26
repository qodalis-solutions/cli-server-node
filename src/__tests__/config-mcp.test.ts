/**
 * MCP tools config_list, config_get (read-only, config:read) and config_set (config:write,
 * not read-only: hidden and refused in read-only mode), secrets never returned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { CliStoredConfigProvider } from '@qodalis/cli-server-abstractions';

const MCP = '/api/qcli/mcp';
const V1 = '/api/v1/qcli';
const ROOT_PASS = 'rootpass1';

function app() {
    return new CliStoredConfigProvider({
        id: 'app',
        title: 'App',
        sections: [
            {
                id: 'main',
                settings: [
                    { key: 'limit', type: 'number', default: 5, validation: { min: 1, max: 10 } },
                    { key: 'apiKey', type: 'secret' },
                ],
            },
        ],
    });
}

let rpcId = 0;
async function rpc(cli: CliServerResult, method: string, params: Record<string, unknown> = {}, token?: string) {
    const req = request(cli.app).post(MCP);
    if (token) req.set('Authorization', `Bearer ${token}`);
    const res = await req.send({ jsonrpc: '2.0', id: ++rpcId, method, params });
    return res.body;
}
const call = (cli: CliServerResult, name: string, args: Record<string, unknown> = {}, token?: string) => rpc(cli, 'tools/call', { name, arguments: args }, token);

describe('config MCP tools (open server)', () => {
    let cli: CliServerResult;
    beforeAll(() => {
        cli = createCliServer({ mcp: true, allowAnonymousAdmin: true, configure: (b) => b.addConfigProvider(app()) });
    });

    it('lists the three tools with permissions-free schemas and read-only hints', async () => {
        const tools = (await rpc(cli, 'tools/list')).result.tools;
        const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
        expect(byName.config_list.annotations).toEqual({ readOnlyHint: true });
        expect(byName.config_get.annotations).toEqual({ readOnlyHint: true });
        expect(byName.config_set.annotations).toMatchObject({ readOnlyHint: false });
        expect(byName.config_get.inputSchema.required).toEqual(['provider']);
        expect(byName.config_set.inputSchema.required).toEqual(['provider', 'section', 'changes']);
        expect(byName.config_set.inputSchema.properties.changes.type).toBe('object');
        // The config command is not also exposed as command tools
        expect(tools.map((t: any) => t.name).filter((n: string) => n.startsWith('config'))).toEqual(['config_list', 'config_get', 'config_set']);
    });

    it('config_list: the default store, providers (with where they read from) and section summaries', async () => {
        const res = await call(cli, 'config_list');
        expect(res.result.isError).toBe(false);
        expect(res.result.structuredContent.defaultStore).toEqual({ kind: 'memory', title: 'In memory', detail: '', persistent: false });
        const providers = res.result.structuredContent.providers;
        expect(providers.map((p: any) => p.id)).toEqual(['server', 'host', 'cors', 'mcp', 'app', 'custom']);
        expect(providers.find((p: any) => p.id === 'app')).toEqual({
            id: 'app',
            title: 'App',
            description: '',
            writable: true,
            storage: { kind: 'store', description: 'Changes are saved to its config store', sources: [] },
            store: { kind: 'memory', title: 'In memory', detail: '', persistent: false },
            sections: [{ id: 'main', title: 'main', mutable: true, version: '0', keys: 2 }],
        });
        // Read-only providers have no store
        expect(providers.find((p: any) => p.id === 'server').store).toBeUndefined();
    });

    it('config_get: a provider, a section, an entry; unknown ones are errors', async () => {
        const provider = (await call(cli, 'config_get', { provider: 'app' })).result.structuredContent.provider;
        expect(provider.id).toBe('app');
        const section = (await call(cli, 'config_get', { provider: 'app', section: 'main' })).result.structuredContent;
        expect(section.section.entries.map((e: any) => e.key)).toEqual(['limit', 'apiKey']);
        const entry = (await call(cli, 'config_get', { provider: 'app', section: 'main', key: 'limit' })).result.structuredContent;
        expect(entry).toMatchObject({ provider: 'app', section: 'main', version: '0', entry: { key: 'limit', value: 5 } });
        const unknownProvider = await call(cli, 'config_get', { provider: 'nope' });
        expect(unknownProvider.result.isError).toBe(true);
        expect(unknownProvider.result.structuredContent).toEqual({ error: 'unknown config provider: nope' });
        expect((await call(cli, 'config_get', { provider: 'app', section: 'nope' })).result).toMatchObject({ isError: true, content: [{ text: 'unknown config section: app.nope' }] });
        expect((await call(cli, 'config_get', { provider: 'app', section: 'main', key: 'nope' })).result).toMatchObject({ isError: true });
        expect((await rpc(cli, 'tools/call', { name: 'config_get', arguments: {} })).error.message).toContain("missing required argument 'provider'");
    });

    it('config_set: applies, answers per-key errors and conflicts, never returns secrets', async () => {
        const ok = await call(cli, 'config_set', { provider: 'app', section: 'main', changes: { limit: 8, apiKey: 'sk_mcp_secret' }, version: '0' });
        expect(ok.result.isError).toBe(false);
        expect(ok.result.structuredContent).toMatchObject({ provider: 'app', applied: ['limit', 'apiKey'], version: '1' });
        expect(JSON.stringify(ok)).not.toContain('sk_mcp_secret');

        const invalid = await call(cli, 'config_set', { provider: 'app', section: 'main', changes: { limit: 50 } });
        expect(invalid.result.isError).toBe(true);
        expect(invalid.result.structuredContent).toEqual({ error: 'validation failed', errors: { limit: 'must be at most 10' } });

        const stale = await call(cli, 'config_set', { provider: 'app', section: 'main', changes: { limit: 2 }, version: '0' });
        expect(stale.result.structuredContent).toEqual({ error: 'version conflict', version: '1' });

        const got = await call(cli, 'config_get', { provider: 'app', section: 'main', key: 'apiKey' });
        expect(got.result.structuredContent.entry).toMatchObject({ value: null, isSet: true });
        expect(JSON.stringify(got)).not.toContain('sk_mcp_secret');

        const bad = await rpc(cli, 'tools/call', { name: 'config_set', arguments: { provider: 'app', section: 'main', changes: 'limit=1' } });
        expect(bad.error.message).toContain("argument 'changes' must be an object");
    });

    it('config_set is refused when the endpoint is read-only', async () => {
        const ro = createCliServer({ mcp: { readOnly: true }, configure: (b) => b.addConfigProvider(app()) });
        const names = (await rpc(ro, 'tools/list')).result.tools.map((t: any) => t.name);
        expect(names).toEqual(expect.arrayContaining(['config_list', 'config_get']));
        expect(names).not.toContain('config_set');
        const refused = await call(ro, 'config_set', { provider: 'app', section: 'main', changes: { limit: 2 } });
        expect(refused.error).toEqual({ code: -32602, message: 'Tool config_set is not available: the MCP endpoint is read-only' });
        expect((await call(ro, 'config_get', { provider: 'app', section: 'main', key: 'limit' })).result.structuredContent.entry.value).toBe(5);
    });

    it('the server_info features list config', async () => {
        expect((await call(cli, 'server_info')).result.structuredContent.features).toContain('config');
    });
});

describe('config MCP tools (protected server)', () => {
    let cli: CliServerResult;
    let users: UsersPluginResult;
    const tokens: Record<string, string> = {};

    beforeAll(async () => {
        cli = createCliServer({
            mcp: true,
            configure: (b) => {
                b.addConfigProvider(app());
                b.addConfigProvider(
                    new CliStoredConfigProvider({ id: 'vault', title: 'Vault', requiredPermission: 'vault:admin', sections: [{ id: 's', settings: [{ key: 'k', type: 'string' }] }] }),
                );
            },
        });
        users = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build();
        await users.ready;
        cli.mountPlugin(users);
        const login = async (username: string, password: string) => (await request(cli.app).post(`${V1}/sessions`).send({ username, password })).body.token as string;
        tokens.root = await login('root', ROOT_PASS);
        const mk = async (name: string, permissions: string[]) => {
            await request(cli.app).post(`${V1}/groups`).set('Authorization', `Bearer ${tokens.root}`).send({ name: `${name}s`, permissions }).expect(201);
            await request(cli.app)
                .post(`${V1}/users`)
                .set('Authorization', `Bearer ${tokens.root}`)
                .send({ name, email: `${name}@x.io`, password: `${name}pass`, groups: [`${name}s`] })
                .expect(201);
            tokens[name] = await login(name, `${name}pass`);
        };
        await mk('runner', ['commands:execute']);
        await mk('reader', ['commands:execute', 'config:read']);
        await mk('writer', ['commands:execute', 'config:read', 'config:write']);
    });
    afterAll(() => users.dispose());

    const names = async (token: string) => ((await rpc(cli, 'tools/list', {}, token)).result.tools as any[]).map((t) => t.name).filter((n) => n.startsWith('config'));

    it('tools follow config:read / config:write', async () => {
        expect(await names(tokens.runner)).toEqual([]);
        expect(await names(tokens.reader)).toEqual(['config_list', 'config_get']);
        expect(await names(tokens.writer)).toEqual(['config_list', 'config_get', 'config_set']);
        expect((await call(cli, 'config_set', { provider: 'app', section: 'main', changes: { limit: 2 } }, tokens.reader)).error.message).toBe('Unknown tool: config_set');
    });

    it("a provider's requiredPermission hides it from the tools too", async () => {
        const list = (await call(cli, 'config_list', {}, tokens.writer)).result.structuredContent.providers.map((p: any) => p.id);
        expect(list).not.toContain('vault');
        const res = await call(cli, 'config_get', { provider: 'vault' }, tokens.writer);
        expect(res.result).toMatchObject({ isError: true, structuredContent: { error: 'forbidden: missing permission vault:admin' } });
        expect((await call(cli, 'config_list', {}, tokens.root)).result.structuredContent.providers.map((p: any) => p.id)).toContain('vault');
    });

    it('changes are audited with via mcp and the caller', async () => {
        await call(cli, 'config_set', { provider: 'app', section: 'main', changes: { limit: 3 } }, tokens.writer);
        const [entry] = await users.auditStore.getEntries({ event: 'config.update' });
        expect(entry).toMatchObject({ username: 'writer', target: 'config:app.main' });
        expect((entry.properties as any).via).toBe('mcp');
    });
});
