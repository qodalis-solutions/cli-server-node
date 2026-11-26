/**
 * On a server without sign-in, anonymous callers are refused what installs code or changes the
 * configuration (plugins:install, dashboard:install, config:write, server:restart) through
 * /execute, /execute/stream and the MCP endpoint, unless the host sets allowAnonymousAdmin
 * (a startup WARNING). Reads stay open, secrets stay masked.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { CliCommandProcessor, CliStoredConfigProvider, type CliProcessCommand } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { anonymousAdminRefusal, ANONYMOUS_ADMIN_PERMISSIONS } from '../auth/anonymous-admin';
import { runCommand } from './command-test-helpers';
import { FakeServerNet, cleanupServerHosts, startServer } from './server-marketplace-test-helpers';
import { FakeNet, TICKETS, cleanupMarketplaceHosts, start as startDashboardHost } from './dashboard-marketplace-test-helpers';

const V1 = '/api/v1/qcli';
const MCP = '/api/qcli/mcp';
const REFUSAL = /^sign-in required: protect the server \(users plugin\) or set allowAnonymousAdmin: true/;

function app() {
    return new CliStoredConfigProvider({
        id: 'app',
        title: 'App',
        sections: [
            {
                id: 'main',
                settings: [
                    { key: 'limit', type: 'number', default: 5 },
                    { key: 'apiKey', type: 'secret' },
                ],
            },
        ],
    });
}

/** A command needing plugins:install that records whether it ran. */
class InstallLike extends CliCommandProcessor {
    command = 'installer';
    description = 'Installs something';
    requiredPermissions = ['plugins:install'];
    runs = 0;
    async handleAsync(_command: CliProcessCommand): Promise<string> {
        this.runs++;
        return 'installed';
    }
}

const servers: CliServerResult[] = [];
function server(options: Parameters<typeof createCliServer>[0] = {}): CliServerResult {
    const cli = createCliServer(options);
    servers.push(cli);
    return cli;
}

afterEach(() => {
    for (const cli of servers.splice(0)) {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    }
    cleanupServerHosts();
    cleanupMarketplaceHosts();
    vi.restoreAllMocks();
});

let rpcId = 0;
async function mcpCall(cli: CliServerResult, name: string, args: Record<string, unknown> = {}) {
    const res = await request(cli.app)
        .post(MCP)
        .send({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
    return res.body.result;
}

describe('anonymousAdminRefusal', () => {
    it('names the refused permissions, nothing for the others', () => {
        expect(ANONYMOUS_ADMIN_PERMISSIONS).toEqual(['plugins:install', 'dashboard:install', 'config:write', 'server:restart']);
        expect(anonymousAdminRefusal(['commands:execute', 'config:read'])).toBeUndefined();
        expect(anonymousAdminRefusal([])).toBeUndefined();
        expect(anonymousAdminRefusal(['admin:access', 'PLUGINS:INSTALL', 'config:write'])).toBe(
            'sign-in required: protect the server (users plugin) or set allowAnonymousAdmin: true (plugins:install, config:write)',
        );
    });
});

describe('anonymous callers on a server without sign-in', () => {
    it('admin plugins install|update|remove refused, search and installed allowed; nothing installed', async () => {
        const net = new FakeServerNet();
        net.publish('weather', { versions: [{ version: '1.0.0' }] });
        const h = await startServer({ net, allowAnonymousAdmin: false });
        const run = (line: string) => runCommand(h.cli, line);

        for (const line of ['admin plugins install weather', 'admin plugins update weather', 'admin plugins remove weather']) {
            const res = await run(line);
            expect(res.text).toMatch(REFUSAL);
            expect(res.text).toContain('(plugins:install)');
        }
        expect((await run('admin plugins search')).text).toContain('weather');
        expect((await run('admin plugins installed')).text).toMatch(/^No server plugins installed/);
        expect(net.calls.filter((u) => u.endsWith('.tgz'))).toEqual([]);
    });

    it('admin dashboard install|update|remove refused, search allowed', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { title: 'Tickets', versions: [{ version: '1.0.0' }] });
        const h = await startDashboardHost({ net, allowAnonymousAdmin: false });
        const run = (line: string) => runCommand(h.cli, line);

        for (const line of [`admin dashboard install ${TICKETS}`, `admin dashboard update ${TICKETS}`, `admin dashboard remove ${TICKETS}`]) {
            const res = await run(line);
            expect(res.text).toMatch(REFUSAL);
            expect(res.text).toContain('(dashboard:install)');
        }
        expect((await run('admin dashboard search')).text).toContain(TICKETS);
        expect((await run('admin dashboard')).text).toMatch(/^No dashboard plugins installed/);
    });

    it('config set|reset refused; config get and list allowed, secrets masked', async () => {
        const provider = app();
        const cli = server({ configure: (b) => b.addConfigProvider(provider) });
        await cli.config.update('app', 'main', { changes: { apiKey: 'top-secret' } }, { hasPermission: () => true });

        const set = await runCommand(cli, 'config set app.main.limit 7');
        expect(set.text).toMatch(REFUSAL);
        expect(set.text).toContain('(config:write)');
        expect((await runCommand(cli, 'config reset app.main.limit')).text).toMatch(REFUSAL);

        const get = await runCommand(cli, 'config get app');
        expect(get.text).toMatch(/limit +5/);
        expect(get.text).toMatch(/apiKey +\(set\)/);
        expect(get.text).not.toContain('top-secret');
        expect((await runCommand(cli, 'config list')).text).toContain('app  App');
        expect((await cli.config.get('app', { hasPermission: () => true })).sections[0].entries.find((e) => e.key === 'limit')!.value).toBe(5);
    });

    it('/execute and /execute/stream refuse; other commands still run', async () => {
        const proc = new InstallLike();
        const cli = server({ configure: (b) => b.addProcessor(proc) });

        const res = await request(cli.app).post(`${V1}/execute`).send({ command: 'installer' });
        expect(res.status).toBe(200);
        expect(res.body.exitCode).toBe(1);
        expect(res.body.outputs[0].value).toMatch(REFUSAL);

        const stream = await request(cli.app).post(`${V1}/execute/stream`).send({ command: 'installer' });
        expect(stream.text).toContain('event: error');
        expect(stream.text).toContain('sign-in required');
        expect(proc.runs).toBe(0);

        expect((await request(cli.app).post(`${V1}/execute`).send({ command: 'config', chainCommands: ['list'] })).body.exitCode).toBe(0);
    });

    it('MCP: command tools and config_set refused; config_list and config_get allowed, writes shown as not writable', async () => {
        const proc = new InstallLike();
        const cli = server({ mcp: true, configure: (b) => b.addProcessor(proc).addConfigProvider(app()) });

        const tool = await mcpCall(cli, 'installer');
        expect(tool.isError).toBe(true);
        expect(tool.content[0].text).toMatch(REFUSAL);
        expect(proc.runs).toBe(0);

        const set = await mcpCall(cli, 'config_set', { provider: 'app', section: 'main', changes: { limit: 7 } });
        expect(set.isError).toBe(true);
        expect(set.content[0].text).toMatch(REFUSAL);

        const list = await mcpCall(cli, 'config_list');
        expect(list.isError).toBe(false);
        expect(list.structuredContent.providers.find((p: { id: string }) => p.id === 'app').writable).toBe(false);
        const get = await mcpCall(cli, 'config_get', { provider: 'app', section: 'main', key: 'limit' });
        expect(get.structuredContent.entry.value).toBe(5);
    });

    it('allowAnonymousAdmin: allowed, with a startup WARNING', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const proc = new InstallLike();
        const cli = server({ allowAnonymousAdmin: true, mcp: true, configure: (b) => b.addProcessor(proc).addConfigProvider(app()) });
        expect(warn.mock.calls.some((c) => String(c[0]).includes('WARNING: allowAnonymousAdmin is on'))).toBe(true);

        expect((await request(cli.app).post(`${V1}/execute`).send({ command: 'installer' })).body.exitCode).toBe(0);
        expect(proc.runs).toBe(1);
        expect((await runCommand(cli, 'config set app.main.limit 7')).text).not.toMatch(REFUSAL);
        expect((await mcpCall(cli, 'config_set', { provider: 'app', section: 'main', changes: { limit: 8 } })).isError).toBe(false);
    });

    it('no WARNING without the opt-in', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        server();
        expect(warn.mock.calls.some((c) => String(c[0]).includes('allowAnonymousAdmin'))).toBe(false);
    });
});
