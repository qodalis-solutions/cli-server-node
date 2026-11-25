/**
 * The admin plugin's `admin` terminal command through POST /execute: status (now, --history, --json), plugins
 * (list, enable, disable: idempotent, unknown, the admin module itself), clients, logs (filters, limits, --since,
 * bad arguments), and admin:access / logs:read on a protected server.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliAdminBuilder, CliAdminPluginResult, formatDuration, formatLogLine, formatTable, summarizeStatusHistory } from '../../plugins/admin/index';
import { parseSince, QueryError } from '../../plugins/admin/services/query-time';
import { CliUsersBuilder } from '../../plugins/users/index';
import { protect, runCommand, subPermissions, ROOT_PASS } from './command-test-helpers';
import type { ICliCommandProcessor, ICliModule } from '@qodalis/cli-server-abstractions';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';

const hosts: Array<{ cli: CliServerResult; admin: CliAdminPluginResult; dispose?: () => void }> = [];
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const h of hosts.splice(0)) {
        h.admin.dispose();
        h.dispose?.();
        h.cli.eventSocketManager.dispose();
        h.cli.logSocketManager.dispose();
    }
});

const weather: ICliModule = {
    name: 'weather',
    version: '2.0.0',
    description: 'Weather',
    author: DefaultLibraryAuthor,
    processors: [
        {
            command: 'forecast',
            description: 'Forecast',
            author: DefaultLibraryAuthor,
            version: '2.0.0',
            handleAsync: async () => 'sunny',
        } as ICliCommandProcessor,
    ],
};

/** `noRecentSample`: the sample the plugin takes when built lands two days ago, out of every --history window. */
function start(options: { users?: boolean; noRecentSample?: boolean } = {}) {
    const now = Date.now();
    if (options.noRecentSample) {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now - 2 * 86_400_000);
    }
    const cli = createCliServer();
    cli.builder.addModule(weather);
    const users = options.users ? new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build() : undefined;
    const builder = new CliAdminBuilder().setCredentials('admin', 'pass').setJwtSecret('secret');
    if (users) builder.setAuthProvider(users.serverAuth);
    const admin = builder.build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, executor: cli.executor, broadcastFn: () => {} });
    admin.logBuffer.restoreConsole();
    admin.statusSampler.stop();
    cli.mountPlugin(admin);
    if (options.noRecentSample) vi.useRealTimers();
    hosts.push({ cli, admin });
    return { cli, admin };
}

const run = runCommand;

describe('admin command: registration', () => {
    it('is the admin module with status, plugins, clients and logs; admin:access on the root, logs:read on logs', () => {
        const { cli } = start();
        const root = cli.registry.findProcessor('admin')!;
        expect(root.requiredPermissions).toEqual(['admin:access']);
        expect(subPermissions(cli, 'admin')).toEqual({ status: undefined, plugins: undefined, clients: undefined, logs: ['logs:read'] });
        expect(cli.builder.modules.some((m) => m.name === 'admin')).toBe(true);
        const plugins = root.processors!.find((p) => p.command === 'plugins')!;
        expect(plugins.processors!.map((p) => p.command)).toEqual(['list', 'enable', 'disable']);
    });
});

describe('admin status', () => {
    it('prints version, platform, uptime, memory, CPU, connections, commands, jobs and features', async () => {
        const { cli } = start();
        const { text, exitCode } = await run(cli, 'admin status');
        expect(exitCode).toBe(0);
        const lines = text.split('\n');
        expect(lines[0]).toMatch(/^Server {6}@qodalis\/cli-server-node \S+/);
        expect(lines[1]).toBe(`Platform    node ${process.version} (${process.platform})`);
        expect(lines[2]).toMatch(/^Uptime {6}\d+ (s|min|h \d+ min|d \d+ h) \(since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\)$/);
        expect(lines[3]).toMatch(/^Memory {6}[\d.]+ MB$/);
        expect(lines[4]).toBe('CPU         n/a');
        expect(lines[5]).toBe('Connections 0 WebSocket, 0 shell');
        expect(lines[6]).toMatch(/^Commands {4}\d+$/);
        expect(lines[7]).toBe('Jobs        0');
        expect(lines[8]).toBe('Features    none');
        // admin alone is the status
        expect((await run(cli, 'admin')).text.split('\n')[0]).toBe(lines[0]);
    });

    it('--json prints the GET /status payload with the server package', async () => {
        const { cli } = start();
        const body = JSON.parse((await run(cli, 'admin status --json')).text);
        expect(body).toMatchObject({ platform: 'node', os: process.platform, server: { id: '@qodalis/cli-server-node' }, cpuUsagePercent: null });
        expect(typeof body.memoryUsageMb).toBe('number');
    });

    it('shows the latest CPU sample when there is one', async () => {
        const { cli, admin } = start();
        admin.statusSampler.add({ timestamp: new Date().toISOString(), memoryMb: 10, cpuPercent: 3.5, activeWsConnections: 0, activeShellSessions: 0 });
        expect((await run(cli, 'admin status')).text).toContain('CPU         3.5%');
    });

    it('--history: count, time span, min/avg/max memory and CPU, peak connections', async () => {
        const { cli, admin } = start({ noRecentSample: true });
        const now = Date.now();
        const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
        admin.statusSampler.add({ timestamp: at(120), memoryMb: 999, cpuPercent: 99, activeWsConnections: 9, activeShellSessions: 9 });
        admin.statusSampler.add({ timestamp: at(30), memoryMb: 100, cpuPercent: null, activeWsConnections: 1, activeShellSessions: 0 });
        admin.statusSampler.add({ timestamp: at(20), memoryMb: 110, cpuPercent: 2, activeWsConnections: 3, activeShellSessions: 1 });
        admin.statusSampler.add({ timestamp: at(10), memoryMb: 120, cpuPercent: 4, activeWsConnections: 2, activeShellSessions: 0 });
        const lines = (await run(cli, 'admin status --history')).text.split('\n');
        expect(lines[0]).toMatch(/^Last 60 min: 3 sample\(s\) every 15 s, \S+ \S+ to \S+ \S+$/);
        expect(lines[1]).toBe('Memory      min 100 MB  avg 110 MB  max 120 MB');
        expect(lines[2]).toBe('CPU         min 2%  avg 3%  max 4%');
        expect(lines[3]).toBe('Peak        3 WebSocket, 1 shell');
        expect((await run(cli, 'admin status --history --minutes 180')).text).toContain('4 sample(s)');
        const json = JSON.parse((await run(cli, 'admin status --history --minutes 15 --json')).text);
        expect(json).toMatchObject({ minutes: 15, intervalSeconds: 15, count: 1, memoryMb: { min: 120, avg: 120, max: 120 } });
    });

    it('--history without samples, CPU n/a when no sample has it', async () => {
        const { cli, admin } = start({ noRecentSample: true });
        expect((await run(cli, 'admin status --history')).text).toBe('No status samples in the last 60 min.');
        admin.statusSampler.add({ timestamp: new Date().toISOString(), memoryMb: 50, cpuPercent: null, activeWsConnections: 0, activeShellSessions: 0 });
        expect((await run(cli, 'admin status --history')).text).toContain('CPU         n/a');
    });

    it('refuses bad --minutes and --minutes without --history', async () => {
        const { cli } = start();
        for (const bad of ['0', '1441', 'x', '1.5']) {
            expect((await run(cli, `admin status --history --minutes ${bad}`)).text).toBe('Error: --minutes must be a whole number from 1 to 1440');
        }
        expect((await run(cli, 'admin status --minutes 5')).text).toBe('Error: --minutes goes with --history');
    });
});

describe('admin plugins', () => {
    it('lists the modules in columns, and as JSON', async () => {
        const { cli } = start();
        const text = (await run(cli, 'admin plugins')).text;
        const lines = text.split('\n');
        expect(lines[0]).toMatch(/^ID\s+Name\s+Version\s+Status\s+Commands$/);
        expect(lines.find((l) => l.startsWith('weather'))).toMatch(/^weather\s+weather\s+2\.0\.0\s+enabled\s+1$/);
        expect(lines.find((l) => l.startsWith('admin'))).toMatch(/^admin\s+admin\s+\S+\s+enabled\s+1$/);
        expect((await run(cli, 'admin plugins list')).text).toBe(text);
        const json = JSON.parse((await run(cli, 'admin plugins --json')).text);
        expect(json.find((m: any) => m.id === 'weather')).toMatchObject({ enabled: true, processors: ['forecast'] });
    });

    it('disable blocks the commands, enable brings them back; both are idempotent; ids are case-insensitive', async () => {
        const { cli } = start();
        expect((await run(cli, 'forecast')).text).toBe('sunny');
        expect((await run(cli, 'admin plugins disable Weather')).text).toBe('Disabled weather (1 command).');
        expect((await run(cli, 'admin plugins disable weather')).text).toBe('weather is already disabled.');
        expect((await run(cli, 'admin plugins')).text).toMatch(/weather\s+weather\s+2\.0\.0\s+disabled/);
        const blocked = await run(cli, 'forecast');
        expect(blocked.exitCode).toBe(1);
        expect(blocked.text).toContain('disabled');
        expect((await run(cli, 'admin plugins enable weather')).text).toBe('Enabled weather (1 command).');
        expect((await run(cli, 'admin plugins enable weather')).text).toBe('weather is already enabled.');
        expect((await run(cli, 'forecast')).text).toBe('sunny');
    });

    it('the same state as the dashboard toggle', async () => {
        const { cli, admin } = start();
        await run(cli, 'admin plugins disable weather');
        const request = (await import('supertest')).default;
        const token = (await request(cli.app).post('/api/v1/qcli/auth/login').send({ username: 'admin', password: 'pass' })).body.token;
        const res = await request(cli.app).get('/api/v1/qcli/plugins/weather').set('Authorization', `Bearer ${token}`);
        expect(res.body.enabled).toBe(false);
        expect(admin.module.processors).toHaveLength(1);
    });

    it('refuses an unknown module, a missing or extra id, and disabling the admin module', async () => {
        const { cli } = start();
        expect((await run(cli, 'admin plugins enable nope')).text).toBe('Error: unknown module: nope (admin plugins lists them)');
        expect((await run(cli, 'admin plugins disable')).text).toBe('Error: name one module: admin plugins disable <id> (admin plugins lists them)');
        expect((await run(cli, 'admin plugins enable a b')).text).toBe('Error: name one module: admin plugins enable <id> (admin plugins lists them)');
        expect((await run(cli, 'admin plugins disable admin')).text).toBe('Error: the admin module cannot be disabled from the terminal: it would disable this command');
        // enabling it is harmless
        expect((await run(cli, 'admin plugins enable admin')).text).toBe('admin is already enabled.');
    });
});

describe('admin clients', () => {
    it('says so when nobody is connected', async () => {
        const { cli } = start();
        expect((await run(cli, 'admin clients')).text).toBe('No WebSocket clients connected.');
        expect((await run(cli, 'admin clients --json')).text).toBe('[]');
    });

    it('lists the connected clients in columns', async () => {
        const { cli } = start();
        vi.spyOn(cli.eventSocketManager, 'getClients').mockReturnValue([
            { id: 'c1', connectedAt: '2026-11-25T10:00:00.000Z', remoteAddress: '127.0.0.1', type: 'events' },
            { id: 'client-2', connectedAt: '2026-11-25T11:30:15.500Z', remoteAddress: '', type: 'events' },
        ]);
        expect((await run(cli, 'admin clients')).text).toBe(
            ['2 client(s)', 'ID        Type    Connected            Address', 'c1        events  2026-11-25 10:00:00  127.0.0.1', 'client-2  events  2026-11-25 11:30:15  -'].join('\n'),
        );
        expect(JSON.parse((await run(cli, 'admin clients --json')).text)).toHaveLength(2);
    });
});

describe('admin logs', () => {
    function withLogs() {
        const h = start();
        const base = Date.now() - 3 * 3600_000;
        const entries: Array<[number, 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', string, string]> = [
            [0, 'INFO', 'server', 'started'],
            [60, 'DEBUG', 'jobs', 'tick'],
            [120, 'WARN', 'jobs', 'slow job cleanup'],
            [170, 'ERROR', 'db', 'connection timeout'],
            [175, 'INFO', 'server', 'request served'],
        ];
        for (const [minutes, level, source, message] of entries) {
            h.admin.logBuffer.push({ timestamp: new Date(base + minutes * 60_000).toISOString(), level, source, message });
        }
        return h;
    }

    it('prints the latest entries oldest first: time, level, [source], message', async () => {
        const { cli } = withLogs();
        const lines = (await run(cli, 'admin logs')).text.split('\n');
        expect(lines).toHaveLength(5);
        expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d INFO  \[server\] started$/);
        expect(lines[3]).toMatch(/ERROR \[db\] connection timeout$/);
    });

    it('-n / --limit keeps the newest and says how many there were', async () => {
        const { cli } = withLogs();
        const lines = (await run(cli, 'admin logs -n 2')).text.split('\n');
        expect(lines[0]).toBe('Last 2 of 5 entries');
        expect(lines[1]).toContain('connection timeout');
        expect(lines[2]).toContain('request served');
        expect((await run(cli, 'admin logs --limit 5')).text.split('\n')).toHaveLength(5);
    });

    it('filters by level (comma-separated, warning = warn), search, service and --since', async () => {
        const { cli } = withLogs();
        expect((await run(cli, 'admin logs --level warn,error')).text.split('\n')).toHaveLength(2);
        expect((await run(cli, 'admin logs --level WARNING')).text).toContain('slow job cleanup');
        expect((await run(cli, 'admin logs --search TIMEOUT')).text).toContain('connection timeout');
        expect((await run(cli, 'admin logs --service jobs')).text.split('\n')).toHaveLength(2);
        expect((await run(cli, 'admin logs --since 30m')).text.split('\n')).toHaveLength(2);
        const iso = new Date(Date.now() - 65 * 60_000).toISOString();
        expect((await run(cli, `admin logs --since ${iso}`)).text.split('\n')).toHaveLength(3);
        expect((await run(cli, 'admin logs --search nothing-like-this')).text).toBe('No log entries match.');
    });

    it('--json prints the entries and the total', async () => {
        const { cli } = withLogs();
        const json = JSON.parse((await run(cli, 'admin logs -n 1 --json')).text);
        expect(json.total).toBe(5);
        expect(json.entries).toEqual([expect.objectContaining({ level: 'INFO', message: 'request served' })]);
    });

    it('says so when the buffer is empty', async () => {
        const { cli } = start();
        expect((await run(cli, 'admin logs')).text).toBe('No log entries match.');
    });

    it('refuses bad arguments', async () => {
        const { cli } = withLogs();
        expect((await run(cli, 'admin logs --level fatal,info')).text).toBe('Error: unknown level fatal (debug, info, warn, error)');
        expect((await run(cli, 'admin logs -n 0')).text).toBe('Error: --limit must be a whole number from 1 to 1000');
        expect((await run(cli, 'admin logs --limit 1001')).text).toBe('Error: --limit must be a whole number from 1 to 1000');
        expect((await run(cli, 'admin logs --since yesterday')).text).toBe('Error: --since must be a duration (30s, 5m, 1h, 7d) or an ISO 8601 date');
        expect((await run(cli, 'admin logs --since 0m')).text).toBe('Error: --since must be more than 0');
        expect((await run(cli, 'admin logs --since 2999-01-01')).text).toBe('Error: --since is in the future');
        expect((await run(cli, 'admin logs --search')).text).toBe('Error: --search needs a value');
    });
});

describe('admin command on a protected server', () => {
    it('needs admin:access, and logs:read for admin logs', async () => {
        const { cli, admin } = start({ users: false });
        const { plugin, tokens } = await protect(cli, {
            runner: ['commands:execute'],
            admin: ['commands:execute', 'admin:access'],
            logger: ['commands:execute', 'admin:access', 'logs:read'],
        });
        hosts[hosts.length - 1].dispose = () => plugin.dispose();
        admin.logBuffer.push({ timestamp: new Date().toISOString(), level: 'INFO', source: 'x', message: 'hello' });

        expect((await run(cli, 'admin status')).status).toBe(401);
        const denied = await run(cli, 'admin status', tokens.runner);
        expect(denied.status).toBe(403);
        expect(denied.body.error).toContain('admin:access');
        expect((await run(cli, 'admin plugins disable weather', tokens.runner)).status).toBe(403);

        expect((await run(cli, 'admin status', tokens.admin)).text).toContain('Platform');
        expect((await run(cli, 'admin plugins', tokens.admin)).text).toContain('weather');
        const noLogs = await run(cli, 'admin logs', tokens.admin);
        expect(noLogs.status).toBe(403);
        expect(noLogs.body.error).toContain('logs:read');
        expect((await run(cli, 'admin logs', tokens.logger)).text).toContain('hello');
        expect((await run(cli, 'admin clients', tokens.root)).text).toBe('No WebSocket clients connected.');
    });
});

describe('admin command helpers', () => {
    it('formatDuration', () => {
        expect(formatDuration(0)).toBe('0 s');
        expect(formatDuration(59)).toBe('59 s');
        expect(formatDuration(60)).toBe('1 min');
        expect(formatDuration(7384)).toBe('2 h 3 min');
        expect(formatDuration(90_000 + 3 * 3600)).toBe('1 d 4 h');
    });

    it('formatTable pads every column but the last', () => {
        expect(formatTable(['A', 'Bee'], [['xx', 'y'], ['z', '']])).toBe('A   Bee\nxx  y\nz');
    });

    it('formatLogLine without a source', () => {
        expect(formatLogLine({ timestamp: '2026-11-25T10:00:00.000Z', level: 'WARN', source: '', message: 'm' })).toBe('2026-11-25 10:00:00 WARN  m');
    });

    it('summarizeStatusHistory of nothing', () => {
        expect(summarizeStatusHistory([])).toEqual({ count: 0, maxWsConnections: 0, maxShellSessions: 0 });
    });

    it('summarizeStatusHistory keeps two decimals in the average', () => {
        const sample = (memoryMb: number) => ({ timestamp: '2026-11-25T10:00:00.000Z', memoryMb, cpuPercent: null, activeWsConnections: 0, activeShellSessions: 0 });
        expect(summarizeStatusHistory([sample(213.95), sample(213.95), sample(214)]).memoryMb).toEqual({ min: 213.95, avg: 213.97, max: 214 });
    });

    it('parseSince', () => {
        const now = new Date('2026-11-25T12:00:00Z');
        expect(parseSince('30s', 's', now).toISOString()).toBe('2026-11-25T11:59:30.000Z');
        expect(parseSince('2H', 's', now).toISOString()).toBe('2026-11-25T10:00:00.000Z');
        expect(parseSince('7d', 's', now).toISOString()).toBe('2026-11-18T12:00:00.000Z');
        expect(parseSince('2026-11-25T08:00', 's', now).toISOString()).toBe('2026-11-25T08:00:00.000Z');
        expect(() => parseSince('5w', 's', now)).toThrow(QueryError);
    });
});
