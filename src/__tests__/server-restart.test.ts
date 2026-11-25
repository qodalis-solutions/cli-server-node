/**
 * Restarting the server: the pending list (markRequired / clearRequired, events), config entries with
 * `requiresRestart` marked and cleared, supervisor detection, the modes (exit, self, handler, auto; the process
 * never exits or spawns: the runtime is mocked), 409 when not supported, 403 without sign-in, permissions on a
 * protected server, audit and events, the graceful shutdown's order on a real HTTP server, and `admin restart`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AddressInfo } from 'net';
import { Server } from 'http';
import request from 'supertest';
import { WebSocket } from 'ws';
import {
    CliStoredConfigProvider,
    cliConfigContext,
    type CliEvent,
} from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerOptions, CliServerResult } from '../create-cli-server';
import { CliServerRestart, CliServerRestartRuntime, detectSupervisor, RESTART_NOT_SUPPORTED } from '../restart';
import { CORE_PERMISSIONS } from '../permissions/cli-permission-catalog';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin/index';
import { protect, runCommand } from './command-test-helpers';

const URL_ = '/api/v1/qcli/server/restart';

/** A runtime that records what the process would do; no supervisor unless `env` says so. */
function fakeRuntime(env: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}) {
    const calls: string[] = [];
    const child = { unref: vi.fn(), pid: 4242 };
    const runtime: Partial<CliServerRestartRuntime> = {
        env,
        exists: (p) => p in files,
        readFile: (p) => files[p],
        exit: vi.fn((code: number) => {
            calls.push(`exit ${code}`);
        }),
        spawn: vi.fn(() => {
            calls.push('spawn');
            return child;
        }),
        execPath: '/usr/bin/node',
        execArgv: ['--require', 'loader.cjs'],
        argv: ['/usr/bin/node', '/app/src/index.ts', '--flag'],
        cwd: () => '/app',
    };
    return { runtime, calls, child };
}

const hosts: Array<{ cli: CliServerResult; admin?: CliAdminPluginResult; server?: Server; dispose?: () => void }> = [];
afterEach(async () => {
    for (const h of hosts.splice(0)) {
        h.admin?.dispose();
        h.dispose?.();
        h.cli.eventSocketManager.dispose();
        h.cli.logSocketManager.dispose();
        if (h.server?.listening) await new Promise((r) => h.server!.close(r));
    }
});

function start(restart: CliServerOptions['restart'], options: { admin?: boolean } = {}) {
    const cli = createCliServer({ restart });
    let admin: CliAdminPluginResult | undefined;
    if (options.admin) {
        admin = new CliAdminBuilder()
            .setCredentials('admin', 'pass')
            .setJwtSecret('secret')
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, executor: cli.executor, broadcastFn: () => {} });
        admin.logBuffer.restoreConsole();
        admin.statusSampler.stop();
        cli.mountPlugin(admin);
    }
    hosts.push({ cli, admin });
    return cli;
}

function events(cli: CliServerResult, pattern = 'server:*'): CliEvent[] {
    const seen: CliEvent[] = [];
    cli.eventBus.subscribe(pattern, (e) => {
        seen.push(e);
    });
    return seen;
}

describe('pending restart list', () => {
    it('marks once per id, clears, publishes server:restart-required to admin:access, is empty at start', async () => {
        const cli = start({ mode: 'exit', runtime: fakeRuntime().runtime });
        const seen = events(cli);
        expect(cli.restart.pending()).toEqual([]);
        cli.restart.markRequired({ id: 'plugin:x', source: 'x', description: 'X installed' });
        cli.restart.markRequired({ id: 'plugin:x', source: 'x', description: 'X installed again' });
        cli.restart.markRequired({ id: 'plugin:y', source: 'y', description: 'Y updated' });
        expect(cli.restart.pending().map((p) => [p.id, p.description])).toEqual([
            ['plugin:x', 'X installed'],
            ['plugin:y', 'Y updated'],
        ]);
        expect(cli.restart.pending()[0].since).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(cli.restart.clearRequired('plugin:x')).toBe(true);
        expect(cli.restart.clearRequired('plugin:x')).toBe(false);
        await new Promise((r) => setImmediate(r));
        expect(seen.map((e) => [e.type, (e.data.pending as unknown[]).length, e.audience.permission])).toEqual([
            ['server:restart-required', 1, 'admin:access'],
            ['server:restart-required', 2, 'admin:access'],
            ['server:restart-required', 1, 'admin:access'],
        ]);
        expect(() => cli.restart.markRequired({ id: '', source: 'x', description: 'd' })).toThrow('markRequired needs');
        // the builder's service is the same one
        expect(cli.builder.restart).toBe(cli.restart);
    });

    it("marks a changed requiresRestart setting and clears it when set back to the value at start", async () => {
        const cli = start({ mode: 'exit', runtime: fakeRuntime().runtime });
        cli.builder.addConfigProvider(
            new CliStoredConfigProvider({
                id: 'app',
                title: 'App',
                sections: [
                    {
                        id: 'main',
                        title: 'Main',
                        settings: [
                            { key: 'port', label: 'Listen port', type: 'number', default: 80, requiresRestart: true },
                            { key: 'name', type: 'string', default: 'x' },
                        ],
                    },
                ],
            }),
        );
        const ctx = cliConfigContext(undefined, 'api');
        await cli.config.update('app', 'main', { changes: { name: 'y' } }, ctx);
        expect(cli.restart.pending()).toEqual([]);
        await cli.config.update('app', 'main', { changes: { port: 81 } }, ctx);
        expect(cli.restart.pending()).toMatchObject([{ id: 'config:app.main.port', source: 'config', description: 'App: Listen port changed' }]);
        await cli.config.update('app', 'main', { changes: { port: 82 } }, ctx);
        expect(cli.restart.pending()).toHaveLength(1);
        await cli.config.update('app', 'main', { changes: { port: 80 } }, ctx);
        expect(cli.restart.pending()).toEqual([]);
    });
});

describe('supervisor detection', () => {
    const detect = (env: NodeJS.ProcessEnv, files: Record<string, string> = {}) =>
        detectSupervisor({ env, exists: (p) => p in files, readFile: (p) => files[p] });

    it('finds PM2, systemd, Kubernetes and Docker from the environment and files', () => {
        expect(detect({})).toBeNull();
        expect(detect({ pm_id: '0' })).toBe('pm2');
        expect(detect({ INVOCATION_ID: 'abc' })).toBe('systemd');
        expect(detect({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })).toBe('kubernetes');
        expect(detect({}, { '/proc/1/cgroup': '0::/kubepods/besteffort/pod1' })).toBe('kubernetes');
        expect(detect({}, { '/.dockerenv': '' })).toBe('docker');
        expect(detect({}, { '/proc/1/cgroup': '12:cpu:/docker/abc' })).toBe('docker');
        expect(detect({ pm_id: '1' }, { '/.dockerenv': '' })).toBe('pm2');
    });
});

describe('restart modes', () => {
    it("auto without a supervisor: not supported, GET says why, POST answers 409", async () => {
        const { runtime, calls } = fakeRuntime();
        const cli = start({ runtime, allowAnonymous: true });
        const res = await request(cli.app).get(URL_).expect(200);
        expect(res.body).toEqual({
            supported: false,
            mode: null,
            supervisor: null,
            reason: 'no supervisor detected; set restart.mode',
            startedAt: cli.restart.startedAt,
            pending: [],
        });
        const post = await request(cli.app).post(URL_).send({});
        expect(post.status).toBe(409);
        expect(post.body).toEqual({ error: RESTART_NOT_SUPPORTED });
        expect(post.body.error).toBe('restart not supported: no supervisor detected; set restart.mode');
        expect(calls).toEqual([]);
    });

    it('auto under systemd: exit with 75 after the graceful shutdown', async () => {
        const { runtime, calls } = fakeRuntime({ INVOCATION_ID: 'x' });
        const cli = start({ runtime, allowAnonymous: true });
        expect((await request(cli.app).get(URL_)).body).toMatchObject({ supported: true, mode: 'exit', supervisor: 'systemd' });
        const res = await request(cli.app).post(URL_).send({ reason: 'apply settings' });
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ restarting: true, pending: [] });
        await cli.restart.completion;
        expect(calls).toEqual(['exit 75']);
    });

    it('exit with a custom exit code, the supervisor reported with an explicit mode', async () => {
        const { runtime, calls } = fakeRuntime({}, { '/.dockerenv': '' });
        const cli = start({ mode: 'exit', exitCode: 3, runtime, allowAnonymous: true });
        expect(cli.restart.status()).toMatchObject({ supported: true, mode: 'exit', supervisor: 'docker' });
        await request(cli.app).post(URL_).expect(202);
        await cli.restart.completion;
        expect(calls).toEqual(['exit 3']);
    });

    it('self: starts the same command (arguments, cwd, env, detached, output inherited), then exits 0', async () => {
        const env = { PORT: '8047', QCLI_DEMO_CONFIG: '/tmp/c.json' };
        const { runtime, calls, child } = fakeRuntime(env);
        const cli = start({ mode: 'self', runtime, allowAnonymous: true });
        expect(cli.restart.status()).toMatchObject({ supported: true, mode: 'self', supervisor: null });
        await request(cli.app).post(URL_).expect(202);
        await cli.restart.completion;
        expect(runtime.spawn).toHaveBeenCalledWith('/usr/bin/node', ['--require', 'loader.cjs', '/app/src/index.ts', '--flag'], {
            cwd: '/app',
            env,
            detached: true,
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        expect(child.unref).toHaveBeenCalled();
        expect(calls).toEqual(['spawn', 'exit 0']);
    });

    it('self: exits 1 when the new process cannot be started', async () => {
        const { runtime, calls } = fakeRuntime();
        runtime.spawn = vi.fn(() => {
            throw new Error('ENOENT');
        });
        const cli = start({ mode: 'self', runtime, allowAnonymous: true });
        await request(cli.app).post(URL_).expect(202);
        await cli.restart.completion;
        expect(calls).toEqual(['exit 1']);
    });

    it("handler: the host's function after the shutdown, with the reason, the pending ids and who asked", async () => {
        const { runtime, calls } = fakeRuntime();
        const handler = vi.fn();
        const cli = start({ mode: 'handler', handler, runtime, allowAnonymous: true });
        cli.restart.markRequired({ id: 'a', source: 's', description: 'A' });
        await request(cli.app).post(URL_).send({ reason: '  why  ' }).expect(202);
        await cli.restart.completion;
        expect(handler).toHaveBeenCalledWith({ reason: 'why', pending: ['a'], by: 'anonymous' });
        expect(calls).toEqual([]);
    });

    it('refuses a handler mode without a handler and an unknown mode', () => {
        expect(() => createCliServer({ restart: { mode: 'handler' } })).toThrow("restart.mode 'handler' needs restart.handler");
        expect(() => createCliServer({ restart: { mode: 'nope' as never } })).toThrow('invalid restart.mode: nope');
    });

    it('validates the reason and refuses a second restart', async () => {
        const { runtime } = fakeRuntime();
        const cli = start({ mode: 'handler', handler: () => {}, runtime, allowAnonymous: true });
        expect((await request(cli.app).post(URL_).send({ reason: 5 })).body).toEqual({ error: 'reason must be a string' });
        expect((await request(cli.app).post(URL_).send({ reason: 'x'.repeat(501) })).status).toBe(400);
        await request(cli.app).post(URL_).expect(202);
        const again = await request(cli.app).post(URL_);
        expect(again.status).toBe(409);
        expect(again.body).toEqual({ error: 'restart already in progress' });
        expect(cli.restart.restarting).toBe(true);
        await cli.restart.completion;
    });

    it('refuses with 403 on a server without sign-in unless allowAnonymous', async () => {
        const { runtime, calls } = fakeRuntime();
        const cli = start({ mode: 'exit', runtime });
        const res = await request(cli.app).post(URL_);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/^restart needs sign-in/);
        // the status stays readable
        expect((await request(cli.app).get(URL_)).body.supported).toBe(true);
        expect(calls).toEqual([]);
    });
});

describe('protected server', () => {
    it('GET needs admin:access, POST server:restart; audits server.restart and publishes server:restarting', async () => {
        const { runtime, calls } = fakeRuntime();
        const cli = start({ mode: 'exit', runtime });
        const { plugin, tokens } = await protect(cli, { viewer: ['admin:access'], restarter: ['server:restart'] });
        hosts.push({ cli, dispose: () => plugin.dispose() });
        const seen = events(cli, 'server:restarting');
        cli.restart.markRequired({ id: 'config:cors.cors.mode', source: 'config', description: 'CORS: Mode changed' });

        expect((await request(cli.app).get(URL_)).status).toBe(401);
        expect((await request(cli.app).get(URL_).set('Authorization', `Bearer ${tokens.restarter}`)).status).toBe(403);
        const status = await request(cli.app).get(URL_).set('Authorization', `Bearer ${tokens.viewer}`).expect(200);
        expect(status.body.pending).toMatchObject([{ id: 'config:cors.cors.mode', description: 'CORS: Mode changed' }]);
        const refused = await request(cli.app).post(URL_).set('Authorization', `Bearer ${tokens.viewer}`);
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({ error: 'forbidden: missing permission server:restart' });

        const res = await request(cli.app).post(URL_).set('Authorization', `Bearer ${tokens.restarter}`).send({ reason: 'apply CORS' });
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ restarting: true, pending: ['config:cors.cors.mode'] });
        await cli.restart.completion;
        expect(calls).toEqual(['exit 75']);

        const [entry] = await plugin.auditStore.getEntries({ event: 'server.restart' });
        expect(entry).toMatchObject({
            event: 'server.restart',
            username: 'restarter',
            actor: 'restarter',
            target: 'server',
            details: 'apply CORS',
        });
        expect(entry.properties).toEqual({ reason: 'apply CORS', by: 'restarter', pending: ['config:cors.cors.mode'], mode: 'exit', via: 'api' });
        expect(seen).toHaveLength(1);
        expect(seen[0].data).toEqual({ reason: 'apply CORS', by: 'restarter', pending: ['config:cors.cors.mode'], mode: 'exit' });
        expect(seen[0].audience).toEqual({ permission: 'admin:access' });
    });

    it('lists server:restart in the catalog, group Server', () => {
        expect(CORE_PERMISSIONS.find((p) => p.name === 'server:restart')).toEqual({ name: 'server:restart', description: 'Restart the server', group: 'Server' });
        const cli = start({ mode: 'exit', runtime: fakeRuntime().runtime });
        expect(cli.builder.permissions.find('server:restart')).toMatchObject({ group: 'Server', surface: 'cli' });
    });
});

describe('graceful shutdown', () => {
    it('stops accepting, finishes in-flight requests, closes sockets with 1012, runs the hooks, then exits', async () => {
        const { runtime, calls } = fakeRuntime();
        const cli = start({ mode: 'exit', runtime, allowAnonymous: true });
        cli.app.get('/slow', (_req, res) => {
            setTimeout(() => {
                calls.push('slow done');
                res.send('ok');
            }, 150);
        });
        const order = calls;
        cli.restart.onShutdown('host', () => {
            order.push('hook');
        });
        const scheduler = { getAll: () => [], get: () => undefined, getRegistration: () => undefined, triggerAsync: async () => {}, cancelCurrentAsync: async () => {}, stop: vi.fn(() => order.push('scheduler stopped')) };
        const dispose = vi.fn(() => order.push('plugin disposed'));
        cli.mountPlugin({ prefix: '/api/v1/qcli/fake', router: (await import('express')).Router(), scheduler, dispose });

        const server = cli.app.listen(0);
        await new Promise((r) => server.once('listening', r));
        cli.eventSocketManager.attach(server);
        hosts[hosts.length - 1].server = server;
        const port = (server.address() as AddressInfo).port;

        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/v1/qcli/events`);
        const messages: string[] = [];
        ws.on('message', (m) => messages.push(String(m)));
        await new Promise((r) => ws.once('open', r));
        const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));

        const slow = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 30));
        const res = await fetch(`http://127.0.0.1:${port}${URL_}`, { method: 'POST' });
        expect(res.status).toBe(202);
        await cli.restart.completion;

        expect(await slow).toBe('ok');
        expect(await closed).toEqual({ code: 1012, reason: 'Server restarting' });
        expect(messages.map((m) => JSON.parse(m).type)).toContain('disconnect');
        // the hooks in registration order (the host's was added before the plugin was mounted)
        expect(order).toEqual(['slow done', 'hook', 'scheduler stopped', 'plugin disposed', 'exit 75']);
        expect(server.listening).toBe(false);
        await expect(fetch(`http://127.0.0.1:${port}/api/qcli/versions`)).rejects.toThrow();
    });

    it('stops waiting for a hung request after the drain timeout', async () => {
        const { runtime, calls } = fakeRuntime();
        const cli = start({ mode: 'exit', runtime, allowAnonymous: true, drainTimeoutMs: 100 });
        cli.app.get('/hang', () => {});
        const server = cli.app.listen(0);
        await new Promise((r) => server.once('listening', r));
        hosts[hosts.length - 1].server = server;
        const port = (server.address() as AddressInfo).port;
        const hung = fetch(`http://127.0.0.1:${port}/hang`).catch(() => 'dropped');
        await new Promise((r) => setTimeout(r, 30));
        await fetch(`http://127.0.0.1:${port}${URL_}`, { method: 'POST' });
        const started = Date.now();
        await cli.restart.completion;
        expect(Date.now() - started).toBeLessThan(3000);
        expect(await hung).toBe('dropped');
        expect(calls).toEqual(['exit 75']);
    });

    it('the service on its own: shutdown without a server runs the hooks', async () => {
        const restart = new CliServerRestart().configure({ mode: 'exit', runtime: fakeRuntime().runtime });
        const ran: string[] = [];
        restart.onShutdown('a', () => ran.push('a'));
        restart.onShutdown('b', () => {
            throw new Error('boom');
        });
        restart.onShutdown('c', async () => ran.push('c'));
        await restart.shutdown();
        expect(ran).toEqual(['a', 'c']);
    });
});

describe('admin restart', () => {
    it('without --yes prints what is pending and how to confirm; with --yes restarts', async () => {
        const { runtime, calls } = fakeRuntime();
        const cli = start({ mode: 'self', runtime }, { admin: true });
        const { plugin, tokens } = await protect(cli, {});
        hosts.push({ cli, dispose: () => plugin.dispose() });
        cli.restart.markRequired({ id: 'config:cors.cors.mode', source: 'config', description: 'CORS: Mode changed' });

        const preview = await runCommand(cli, 'admin restart', tokens.root);
        expect(preview.text).toContain('1 change(s) take effect after a restart:');
        expect(preview.text).toContain('  - CORS: Mode changed (config, since ');
        expect(preview.text).toContain('Restart mode: self (starts itself again)');
        expect(preview.text).toContain('Run admin restart --yes [--reason "<why>"] to restart the server now.');
        expect(calls).toEqual([]);

        const status = await runCommand(cli, 'admin restart status', tokens.root);
        expect(status.text).toMatch(/^Running since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\nRestart mode: self/);
        const json = JSON.parse((await runCommand(cli, 'admin restart status --json', tokens.root)).text);
        expect(json).toMatchObject({ supported: true, mode: 'self', pending: [{ id: 'config:cors.cors.mode' }] });

        const done = await runCommand(cli, 'admin restart --yes --reason "apply CORS"', tokens.root);
        expect(done.text).toBe('Restarting the server to apply 1 pending change(s) (self mode). The connection drops and comes back once it runs again.');
        await cli.restart.completion;
        expect(calls).toEqual(['spawn', 'exit 0']);
        const [entry] = await plugin.auditStore.getEntries({ event: 'server.restart' });
        expect(entry.properties).toMatchObject({ reason: 'apply CORS', by: 'root', via: 'command' });
    });

    it('status needs only admin:access; restarting needs server:restart', async () => {
        const { runtime, calls } = fakeRuntime();
        const cli = start({ mode: 'exit', runtime }, { admin: true });
        const { plugin, tokens } = await protect(cli, { viewer: ['admin:access', 'commands:execute'] });
        hosts.push({ cli, dispose: () => plugin.dispose() });
        expect((await runCommand(cli, 'admin restart status', tokens.viewer)).text).toContain('No changes are waiting for a restart.');
        expect((await runCommand(cli, 'admin restart --yes', tokens.viewer)).text).toBe('Error: forbidden: missing permission server:restart');
        expect(calls).toEqual([]);
    });

    it('says when restarting is not supported', async () => {
        const cli = start({ runtime: fakeRuntime().runtime }, { admin: true });
        const { plugin, tokens } = await protect(cli, {});
        hosts.push({ cli, dispose: () => plugin.dispose() });
        const res = await runCommand(cli, 'admin restart --yes', tokens.root);
        expect(res.text).toContain('Error: restart not supported: no supervisor detected; set restart.mode');
        expect((await runCommand(cli, 'admin restart status', tokens.root)).text).toContain('Restart from here: not supported');
    });
});
