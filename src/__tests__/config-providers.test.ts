/**
 * The built-in config providers and their runtime effect: server, host (secrets masked),
 * cors (live origins), mcp (tool lists, read-only), filesystem (upload limit), jobs
 * (history retention), logs (buffer), custom; persistence through the stores.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createCliServer, CliServerOptions } from '../create-cli-server';
import { CliHostConfigProvider, DEFAULT_ENVIRONMENT_ALLOW, isSecretEnvironmentVariable } from '../config/providers/host-config-provider';
import { InMemoryFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { CliJobsBuilder, HISTORY_PRUNE_JOB_ID } from '@qodalis/cli-server-plugin-jobs';
import { CliDatabaseConfigStore, sqliteConnection } from '@qodalis/cli-server-plugin-databases';
import { LogRingBuffer, createLogsConfigProvider } from '../../plugins/admin';
import {
    JsonFileConfigStore,
    cliConfigContext,
    type CliConfigProviderView,
    type CliConfigSectionView,
} from '@qodalis/cli-server-abstractions';

const all = cliConfigContext(undefined, 'api');
const MCP = '/api/qcli/mcp';

function section(view: CliConfigProviderView, id: string): CliConfigSectionView {
    const s = view.sections.find((x) => x.id === id);
    if (!s) throw new Error(`no section ${id}`);
    return s;
}
const valueOf = (s: CliConfigSectionView, key: string) => s.entries.find((e) => e.key === key)?.value;

const temp: string[] = [];
afterEach(() => {
    for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-config-providers-'));
    temp.push(dir);
    return dir;
}

async function mcpCall(app: any, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const res = await request(app).post(MCP).set(headers).send({ jsonrpc: '2.0', id: 1, method, params });
    return res.body;
}

describe('built-in providers', () => {
    it('registered on every server, in order; filesystem only with a filesystem', async () => {
        const plain = createCliServer({});
        expect(plain.builder.configProviders.map((p) => p.id)).toEqual(['server', 'host', 'cors', 'mcp', 'custom']);
        const withFs = createCliServer({ configure: (b) => b.setFileStorageProvider(new InMemoryFileStorageProvider()) });
        expect(withFs.builder.configProviders.map((p) => p.id)).toContain('filesystem');
        expect(plain.config).toBe(plain.builder.config);
    });

    it('a host provider with a built-in id replaces the built-in', async () => {
        const cli = createCliServer({
            configure: (b) => b.addConfigProvider({ id: 'custom', title: 'Mine', getSections: () => [] }),
        });
        expect((await cli.config.get('custom', all)).title).toBe('Mine');
    });

    it('server: the process, read-only', async () => {
        const view = await createCliServer({}).config.get('server', all);
        expect(view.writable).toBe(false);
        const runtime = section(view, 'runtime');
        expect(valueOf(runtime, 'platform')).toBe('node');
        expect(valueOf(runtime, 'platformVersion')).toBe(process.version);
        expect(valueOf(runtime, 'pid')).toBe(process.pid);
        expect(valueOf(runtime, 'uptime')).toMatch(/^\d+(ms|s|m|h|d)$/);
        expect(runtime.entries.every((e) => !e.mutable)).toBe(true);
    });
});

describe('host: options and environment, secrets masked', () => {
    it('names and URLs that hold secrets', () => {
        for (const name of [
            'DB_PASSWORD', 'JWT_SECRET', 'GITHUB_TOKEN', 'API_KEY', 'STRIPE_APIKEY', 'KEY', 'AWS_SECRET_ACCESS_KEY', 'PRIVATE_KEY_PATH',
            'SESSION_COOKIE', 'SENTRY_DSN', 'CONNECTION_STRING', 'QCLI_ADMIN_PASSWORD', 'BASIC_AUTH', 'TERM_SESSION_ID', 'SSH_PASSPHRASE',
            'DB_PASS', 'MONGO_CONN', 'REDIS_CONNSTR', 'GPG_KEYRING', 'ssh_auth_sock', 'Oauth_Client', 'X_CREDENTIALS',
        ]) {
            expect(isSecretEnvironmentVariable(name, 'x'), name).toBe(true);
        }
        for (const name of ['PATH', 'HOME', 'NODE_ENV', 'PORT', 'PWD', 'HOST', 'TZ', 'LANG', 'QCLI_PORT']) {
            expect(isSecretEnvironmentVariable(name, 'x')).toBe(false);
        }
        expect(isSecretEnvironmentVariable('DATABASE_URL', 'postgres://user:pw@db:5432/app')).toBe(true);
        expect(isSecretEnvironmentVariable('DATABASE_URL', 'postgres://db:5432/app')).toBe(false);
        expect(isSecretEnvironmentVariable('UPSTREAM', 'https://admin:hunter2@example.com/x')).toBe(true);
        expect(isSecretEnvironmentVariable('UPSTREAM', 'https://user@example.com/x')).toBe(false);
        expect(isSecretEnvironmentVariable('MY_THING', 'x', ['MY_*'])).toBe(true);
    });

    it('shows only QCLI_* and a few harmless variables by default; allow adds names, secrets still masked', () => {
        expect([...DEFAULT_ENVIRONMENT_ALLOW]).toEqual(['QCLI_*', 'NODE_ENV', 'PORT', 'HOST', 'TZ', 'LANG']);
        const env = {
            PATH: '/usr/bin', HOME: '/home/x', TERM_SESSION_ID: 'abc', SSH_AUTH_SOCK: '/tmp/ssh', AWS_ACCESS_KEY_ID: 'AKIA',
            NODE_ENV: 'production', PORT: '8047', HOST: '0.0.0.0', TZ: 'UTC', LANG: 'en_US.UTF-8', QCLI_URL: 'https://a:b@x.io', QCLI_MODE: 'demo', APP_REGION: 'eu',
        };
        const keys = (o: object) => new CliHostConfigProvider(() => [], o, env).getSections()[1].entries.map((e) => e.key);
        expect(keys({})).toEqual(['HOST', 'LANG', 'NODE_ENV', 'PORT', 'QCLI_MODE', 'QCLI_URL', 'TZ']);
        expect(keys({ allow: ['APP_*', 'TERM_SESSION_ID'] })).toEqual(['APP_REGION', 'HOST', 'LANG', 'NODE_ENV', 'PORT', 'QCLI_MODE', 'QCLI_URL', 'TERM_SESSION_ID', 'TZ']);
        const entries = new CliHostConfigProvider(() => [], { allow: ['TERM_SESSION_ID'] }, env).getSections()[1].entries;
        expect(entries.find((e) => e.key === 'TERM_SESSION_ID')).toMatchObject({ type: 'secret', value: null, isSet: true });
        expect(entries.find((e) => e.key === 'QCLI_URL')).toMatchObject({ type: 'secret', value: null });
        expect(entries.find((e) => e.key === 'QCLI_MODE')).toMatchObject({ value: 'demo' });
        expect(JSON.stringify(entries)).not.toMatch(/\/usr\/bin|abc|AKIA|a:b@/);
    });

    it('lists the environment sorted, masks secrets, include / exclude', () => {
        const env = { ZED: 'z', ALPHA: 'a', DB_PASSWORD: 'hunter2', EMPTY_TOKEN: '', npm_config_x: '1', DATABASE_URL: 'mysql://u:p@h/db', QCLI_PORT: '8047' };
        const host = new CliHostConfigProvider(() => [{ key: 'basePath', value: '/api/qcli' }], { include: ['*'] }, env);
        const [options, environment] = host.getSections();
        expect(options.entries).toEqual([{ key: 'basePath', type: 'string', value: '/api/qcli' }]);
        expect(environment.entries.map((e) => e.key)).toEqual(['ALPHA', 'DATABASE_URL', 'DB_PASSWORD', 'EMPTY_TOKEN', 'QCLI_PORT', 'ZED']);
        expect(environment.entries.find((e) => e.key === 'DB_PASSWORD')).toEqual({ key: 'DB_PASSWORD', type: 'secret', value: null, isSet: true, sensitive: true, source: 'environment' });
        expect(environment.entries.find((e) => e.key === 'EMPTY_TOKEN')).toMatchObject({ isSet: false });
        expect(environment.entries.find((e) => e.key === 'DATABASE_URL')).toMatchObject({ type: 'secret', value: null });
        expect(environment.entries.find((e) => e.key === 'ALPHA')).toEqual({ key: 'ALPHA', type: 'string', value: 'a', source: 'environment' });
        expect(JSON.stringify(environment)).not.toMatch(/hunter2|u:p@h/);

        const only = new CliHostConfigProvider(() => [], { include: ['QCLI_*', 'ZED'], exclude: ['ZED'], secrets: ['QCLI_PORT'] }, env);
        expect(only.getSections()[1].entries).toEqual([{ key: 'QCLI_PORT', type: 'secret', value: null, isSet: true, sensitive: true, source: 'environment' }]);
    });

    it('through the server: options typed, secrets never in the response', async () => {
        process.env.QCLI_CFGTEST_SECRET_TOKEN = 'do-not-show-me';
        try {
            const cli = createCliServer({ basePath: '/api/custom', maxTableRows: 50, config: { environment: { include: ['QCLI_CFGTEST_*'] } } });
            const view = await cli.config.get('host', all);
            const options = section(view, 'options');
            expect(valueOf(options, 'basePath')).toBe('/api/custom');
            expect(options.entries.find((e) => e.key === 'maxTableRows')).toMatchObject({ type: 'number', value: 50 });
            expect(options.entries.find((e) => e.key === 'enableShell')).toMatchObject({ type: 'boolean', value: false });
            expect(section(view, 'environment').entries).toEqual([
                expect.objectContaining({ key: 'QCLI_CFGTEST_SECRET_TOKEN', value: null, isSet: true, sensitive: true }),
            ]);
            expect(JSON.stringify(view)).not.toContain('do-not-show-me');
        } finally {
            delete process.env.QCLI_CFGTEST_SECRET_TOKEN;
        }
    });
});

describe('cors: allowed origins at runtime', () => {
    const origin = 'https://new.example';

    it('a new origin gets CORS headers right away; reset restores the start list', async () => {
        const cli = createCliServer({ allowedOrigins: ['https://old.example'] });
        const view = await cli.config.get('cors', all);
        const cors = section(view, 'cors');
        expect(valueOf(cors, 'mode')).toBe('origins');
        expect(valueOf(cors, 'allowedOrigins')).toEqual(['https://old.example']);
        expect(cors.entries.find((e) => e.key === 'allowedOrigins')).toMatchObject({ type: 'string[]', editor: 'origins', mutable: true });

        const before = await request(cli.app).get('/api/v1/qcli/version').set('Origin', origin);
        expect(before.headers['access-control-allow-origin']).toBeUndefined();

        await cli.config.update('cors', 'cors', { changes: { allowedOrigins: ['https://old.example', origin] } }, all);
        const after = await request(cli.app).get('/api/v1/qcli/version').set('Origin', origin);
        expect(after.headers['access-control-allow-origin']).toBe(origin);

        await cli.config.update('cors', 'cors', { changes: { allowedOrigins: null } }, all);
        const reset = await request(cli.app).get('/api/v1/qcli/version').set('Origin', origin);
        expect(reset.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('a server started without origins can add some (CORS middleware is always ready)', async () => {
        const cli = createCliServer({});
        expect((await request(cli.app).get('/api/v1/qcli/version').set('Origin', origin)).headers['access-control-allow-origin']).toBeUndefined();
        await cli.config.update('cors', 'cors', { changes: { allowedOrigins: [origin] } }, all);
        expect((await request(cli.app).get('/api/v1/qcli/version').set('Origin', origin)).headers['access-control-allow-origin']).toBe(origin);
    });

    it('the MCP endpoint follows the live list (DNS-rebinding check)', async () => {
        const cli = createCliServer({ mcp: true, allowedOrigins: [] });
        const init = { jsonrpc: '2.0', id: 1, method: 'ping', params: {} };
        expect((await request(cli.app).post(MCP).set('Origin', origin).send(init)).status).toBe(403);
        await cli.config.update('cors', 'cors', { changes: { allowedOrigins: [origin] } }, all);
        expect((await request(cli.app).post(MCP).set('Origin', origin).send(init)).status).toBe(200);
    });

    it('validates each origin', async () => {
        const cli = createCliServer({});
        for (const bad of ['example.com', 'https://a.example/path', 'ftp://a.example', '*', 'https://a.example:99999']) {
            await expect(cli.config.update('cors', 'cors', { changes: { allowedOrigins: [bad] } }, all)).rejects.toMatchObject({
                status: 400,
                errors: { allowedOrigins: expect.stringContaining('is not an origin') },
            });
        }
        await expect(cli.config.update('cors', 'cors', { changes: { allowedOrigins: ['http://localhost:*', 'https://a.example:8443', 'http://h/'] } }, all)).resolves.toBeDefined();
    });

    it('the mode reflects the cors option and is read-only', async () => {
        const modes: Array<[CliServerOptions['cors'], string]> = [[true, 'permissive'], [false, 'disabled'], [{ origin: true }, 'custom'], [undefined, 'origins']];
        for (const [option, mode] of modes) {
            const cli = createCliServer({ cors: option });
            expect(valueOf(section(await cli.config.get('cors', all), 'cors'), 'mode')).toBe(mode);
        }
        const cli = createCliServer({});
        await expect(cli.config.update('cors', 'cors', { changes: { mode: 'permissive' } }, all)).rejects.toMatchObject({ errors: { mode: 'read-only' } });
    });

    it("never changes the host's own array", async () => {
        const origins = ['https://a.example'];
        const cli = createCliServer({ allowedOrigins: origins });
        await cli.config.update('cors', 'cors', { changes: { allowedOrigins: ['https://b.example'] } }, all);
        expect(origins).toEqual(['https://a.example']);
    });
});

describe('mcp: tool lists and read-only mode at runtime', () => {
    const names = async (app: any) => (await mcpCall(app, 'tools/list')).result.tools.map((t: any) => t.name) as string[];

    it('read-only hides config_set (and other writing tools); a call is refused', async () => {
        const cli = createCliServer({ mcp: true });
        expect(await names(cli.app)).toEqual(expect.arrayContaining(['config_list', 'config_get', 'config_set']));
        await cli.config.update('mcp', 'mcp', { changes: { readOnly: true } }, all);
        const listed = await names(cli.app);
        expect(listed).toEqual(expect.arrayContaining(['config_list', 'config_get', 'server_info']));
        expect(listed).not.toContain('config_set');
        const call = await mcpCall(cli.app, 'tools/call', { name: 'config_set', arguments: { provider: 'custom', section: 'custom', changes: { a: 1 } } });
        expect(call.error).toEqual({ code: -32602, message: 'Tool config_set is not available: the MCP endpoint is read-only' });
        const custom = await cli.config.get('custom', all);
        expect(custom.sections[0].entries).toEqual([]);
        await cli.config.update('mcp', 'mcp', { changes: { readOnly: null } }, all);
        expect(await names(cli.app)).toContain('config_set');
    });

    it('allow-list and deny-list; empty allows every tool', async () => {
        const cli = createCliServer({ mcp: { exclude: ['server_info'] } });
        expect(await names(cli.app)).not.toContain('server_info');
        await cli.config.update('mcp', 'mcp', { changes: { tools: ['config_*'], exclude: [] } }, all);
        expect((await names(cli.app)).sort()).toEqual(['config_get', 'config_list', 'config_set']);
        await cli.config.update('mcp', 'mcp', { changes: { tools: [] } }, all);
        expect(await names(cli.app)).toContain('server_info');
        await cli.config.update('mcp', 'mcp', { changes: { exclude: null } }, all);
        expect(await names(cli.app)).not.toContain('server_info');
    });

    it('instructions are returned by initialize', async () => {
        const cli = createCliServer({ mcp: { instructions: 'first' } });
        const init = async () => (await mcpCall(cli.app, 'initialize', { protocolVersion: '2025-06-18' })).result.instructions;
        expect(await init()).toBe('first');
        await cli.config.update('mcp', 'mcp', { changes: { instructions: 'second' } }, all);
        expect(await init()).toBe('second');
        await cli.config.update('mcp', 'mcp', { changes: { instructions: '' } }, all);
        expect(await init()).toBeUndefined();
    });

    it('validates tool patterns; read-only when MCP is off', async () => {
        const on = createCliServer({ mcp: true });
        await expect(on.config.update('mcp', 'mcp', { changes: { tools: ['Bad Name'] } }, all)).rejects.toMatchObject({ status: 400 });
        const off = createCliServer({});
        const view = section(await off.config.get('mcp', all), 'mcp');
        expect(valueOf(view, 'enabled')).toBe(false);
        expect(view.mutable).toBe(false);
        await expect(off.config.update('mcp', 'mcp', { changes: { readOnly: true } }, all)).rejects.toMatchObject({ status: 400 });
    });

    it("never changes the host's mcp object", async () => {
        const options = { tools: ['a_*'] };
        const cli = createCliServer({ mcp: options });
        await cli.config.update('mcp', 'mcp', { changes: { tools: ['b_*'], readOnly: true } }, all);
        expect(options).toEqual({ tools: ['a_*'] });
    });
});

describe('filesystem: the upload limit at runtime', () => {
    it('a lower limit refuses larger uploads with 413; storage and roots are read-only', async () => {
        const cli = createCliServer({ configure: (b) => b.setFileStorageProvider(new InMemoryFileStorageProvider(), { maxUploadBytes: 1000 }) });
        const view = section(await cli.config.get('filesystem', all), 'filesystem');
        expect(valueOf(view, 'maxUploadBytes')).toBe(1000);
        expect(view.entries.find((e) => e.key === 'allowedPaths')).toMatchObject({ mutable: false });
        expect(view.entries.find((e) => e.key === 'storage')).toMatchObject({ mutable: false });
        const upload = () => request(cli.app).post('/api/qcli/fs/upload').field('path', '/a.txt').attach('file', Buffer.alloc(500), 'a.txt');
        expect((await upload()).status).toBe(200);
        await cli.config.update('filesystem', 'filesystem', { changes: { maxUploadBytes: 100 } }, all);
        const refused = await upload();
        expect(refused.status).toBe(413);
        expect(refused.body.error).toContain('100 bytes');
        await expect(cli.config.update('filesystem', 'filesystem', { changes: { maxUploadBytes: 1.5 } }, all)).rejects.toMatchObject({ status: 400 });
        await expect(cli.config.update('filesystem', 'filesystem', { changes: { allowedPaths: ['/'] } }, all)).rejects.toMatchObject({ errors: { allowedPaths: 'read-only' } });
        await cli.config.update('filesystem', 'filesystem', { changes: { maxUploadBytes: null } }, all);
        expect((await upload()).status).toBe(200);
    });
});

describe('jobs: history retention defaults at runtime', () => {
    it('changes the scheduler, registers the prune job when needed, validates durations', async () => {
        const jobs = new CliJobsBuilder().build();
        const cli = createCliServer({});
        cli.mountPlugin(jobs);
        const view = section(await cli.config.get('jobs', all), 'history');
        expect(valueOf(view, 'maxAge')).toBeNull();
        expect(valueOf(view, 'pruneInterval')).toBe('1d');
        expect(jobs.scheduler.historyRetention().defaults).toBeUndefined();
        expect(jobs.scheduler.getRegistration(HISTORY_PRUNE_JOB_ID)).toBeUndefined();

        await cli.config.update('jobs', 'history', { changes: { maxAge: '30d', maxRunsPerJob: 100 } }, all);
        expect(jobs.scheduler.historyRetention().defaults).toEqual({ maxAgeMs: 30 * 86_400_000, maxRuns: 100 });
        expect(jobs.scheduler.historyDefaults).toEqual({ maxAge: '30d', maxRunsPerJob: 100 });
        expect(jobs.scheduler.getRegistration(HISTORY_PRUNE_JOB_ID)).toBeDefined();

        await expect(cli.config.update('jobs', 'history', { changes: { maxAge: '500ms' } }, all)).rejects.toMatchObject({ status: 400 });
        await expect(cli.config.update('jobs', 'history', { changes: { maxRunsPerJob: 0 } }, all)).rejects.toMatchObject({ errors: { maxRunsPerJob: 'must be at least 1' } });
        await expect(cli.config.update('jobs', 'history', { changes: { pruneInterval: '1h' } }, all)).rejects.toMatchObject({ errors: { pruneInterval: 'read-only' } });

        await cli.config.update('jobs', 'history', { changes: { maxAge: null } }, all);
        expect(jobs.scheduler.historyRetention().defaults).toEqual({ maxRuns: 100 });
    });

    it('defaults come from the plugin options', async () => {
        const jobs = new CliJobsBuilder({ history: { maxAge: 7 * 86_400_000, failedMaxRunsPerJob: 5, pruneInterval: '6h' } }).build();
        const cli = createCliServer({});
        cli.mountPlugin(jobs);
        const view = section(await cli.config.get('jobs', all), 'history');
        expect(valueOf(view, 'maxAge')).toBe('7d');
        expect(valueOf(view, 'failedMaxRunsPerJob')).toBe(5);
        expect(valueOf(view, 'pruneInterval')).toBe('6h');
    });
});

describe('logs: the admin log buffer', () => {
    it('capacity and lowest level change the buffer', async () => {
        const buffer = new LogRingBuffer(150);
        const provider = createLogsConfigProvider(buffer);
        for (let i = 0; i < 150; i++) buffer.push({ timestamp: new Date().toISOString(), level: 'INFO', message: `m${i}`, source: 't' });
        await provider.update('buffer', { capacity: 100 }, undefined);
        expect(buffer.capacity).toBe(100);
        const kept = buffer.query({ limit: 1000 }).entries;
        expect(kept).toHaveLength(100);
        expect(kept[0].message).toBe('m50');
        expect(kept[99].message).toBe('m149');
        buffer.push({ timestamp: new Date().toISOString(), level: 'INFO', message: 'next', source: 't' });
        expect(buffer.query({ limit: 1000 }).entries.at(-1)!.message).toBe('next');

        await provider.update('buffer', { minLevel: 'WARN' }, undefined);
        buffer.push({ timestamp: new Date().toISOString(), level: 'INFO', message: 'dropped', source: 't' });
        buffer.push({ timestamp: new Date().toISOString(), level: 'ERROR', message: 'kept', source: 't' });
        const messages = buffer.query({ limit: 1000 }).entries.map((e) => e.message);
        expect(messages).not.toContain('dropped');
        expect(messages.at(-1)).toBe('kept');

        expect(provider.validate('buffer', { capacity: 150.5 })).toEqual({ capacity: 'must be a whole number' });
        await provider.update('buffer', { capacity: null, minLevel: null }, undefined);
        expect(buffer.capacity).toBe(150);
        expect(buffer.minLevel).toBe('DEBUG');
    });

    it('resize grows and keeps order; invalid sizes and levels throw', () => {
        const buffer = new LogRingBuffer(3);
        for (const m of ['a', 'b', 'c', 'd']) buffer.push({ timestamp: new Date().toISOString(), level: 'INFO', message: m, source: 't' });
        buffer.resize(5);
        buffer.push({ timestamp: new Date().toISOString(), level: 'INFO', message: 'e', source: 't' });
        expect(buffer.query({ limit: 10 }).entries.map((e) => e.message)).toEqual(['b', 'c', 'd', 'e']);
        expect(() => buffer.resize(0)).toThrow();
        expect(() => (buffer.minLevel = 'TRACE' as any)).toThrow();
    });
});

describe('persistence', () => {
    it('JSON file store: a change survives a restart and is applied at startup', async () => {
        const file = path.join(tempDir(), 'config.json');
        const first = createCliServer({ config: { store: new JsonFileConfigStore(file) } });
        await first.config.ready();
        await first.config.update('cors', 'cors', { changes: { allowedOrigins: ['https://kept.example'] } }, all);
        await first.config.update('custom', 'custom', { changes: { motd: 'hello' } }, all);

        const second = createCliServer({ configure: (b) => b.setConfigStore(new JsonFileConfigStore(file)) });
        await second.config.ready();
        const res = await request(second.app).get('/api/v1/qcli/version').set('Origin', 'https://kept.example');
        expect(res.headers['access-control-allow-origin']).toBe('https://kept.example');
        const cors = section(await second.config.get('cors', all), 'cors');
        expect(cors.entries.find((e) => e.key === 'allowedOrigins')).toMatchObject({ value: ['https://kept.example'], source: 'file' });
        expect(cors.version).toBe('1');
        expect(valueOf(section(await second.config.get('custom', all), 'custom'), 'motd')).toBe('hello');
    });

    it('database store: applied once ready (a plugin mounted later included)', async () => {
        const db = new Database(':memory:');
        const store = new CliDatabaseConfigStore({ connection: sqliteConnection(db) });
        await store.write('jobs', 'history', { maxRunsPerJob: 7 });
        await store.write('mcp', 'mcp', { readOnly: true });
        const cli = createCliServer({ mcp: true, config: { store } });
        const jobs = new CliJobsBuilder().build();
        cli.mountPlugin(jobs);
        await cli.config.ready();
        expect(jobs.scheduler.historyDefaults).toEqual({ maxRunsPerJob: 7 });
        const listed = (await mcpCall(cli.app, 'tools/list')).result.tools.map((t: any) => t.name);
        expect(listed).not.toContain('config_set');
        const view = section(await cli.config.get('jobs', all), 'history');
        expect(view.entries.find((e) => e.key === 'maxRunsPerJob')).toMatchObject({ value: 7, source: 'database' });
        db.close();
    });

    it('the store cannot change once the server is created', () => {
        const cli = createCliServer({});
        expect(() => cli.builder.setConfigStore(new JsonFileConfigStore(path.join(tempDir(), 'x.json')))).toThrow(
            'the config store must be set before the server is created',
        );
    });
});
