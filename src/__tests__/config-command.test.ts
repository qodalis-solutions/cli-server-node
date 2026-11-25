/**
 * The `config` terminal command through POST /api/v1/qcli/execute: list, get, set, reset;
 * values parsed by type, per-key errors, --version conflicts, secrets never printed,
 * config:read / config:write on a protected server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliStoredConfigProvider, InMemoryConfigStore, JsonFileConfigStore, splitShellWords } from '@qodalis/cli-server-abstractions';
import { formatConfigValue } from '../config/config-command';

const V1 = '/api/v1/qcli';
const ROOT_PASS = 'rootpass1';

function app() {
    return new CliStoredConfigProvider({
        id: 'app',
        title: 'App',
        description: 'The app',
        sections: [
            {
                id: 'main',
                title: 'Main',
                settings: [
                    { key: 'limit', type: 'number', default: 5, validation: { min: 1, max: 10 }, description: 'How many' },
                    { key: 'apiKey', type: 'secret' },
                    { key: 'tags', type: 'string[]', default: [] },
                    { key: 'beta', type: 'boolean', default: false },
                    { key: 'timeout', type: 'duration', default: '30s', requiresRestart: true },
                    { key: 'mode', type: 'enum', default: 'a', validation: { options: ['a', 'b'] } },
                    { key: 'fixed', type: 'string', mutable: false, default: 'x' },
                ],
            },
            // A section id with a dot: the longest matching section wins
            { id: 'main.extra', settings: [{ key: 'deep.key', type: 'string', default: 'd' }] },
        ],
    });
}

/** Runs a command line the way the browser sends it (sub-commands, positionals, --flags). */
async function run(cli: CliServerResult, line: string, token?: string): Promise<{ status: number; text: string; body: any }> {
    const words = splitShellWords(line);
    const [command, sub, ...rest] = words;
    const positionals: string[] = [];
    const args: Record<string, unknown> = {};
    for (let i = 0; i < rest.length; i++) {
        if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[++i];
        else positionals.push(rest[i]);
    }
    const req = request(cli.app).post(`${V1}/execute`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    const res = await req.send({
        command,
        chainCommands: sub ? [sub] : [],
        rawCommand: line,
        value: positionals.join(' ') || undefined,
        positionals,
        args,
    });
    const text = (res.body?.outputs ?? []).map((o: any) => o.value).join('\n');
    return { status: res.status, text, body: res.body };
}

describe('config command (open server)', () => {
    let cli: CliServerResult;
    beforeAll(() => {
        cli = createCliServer({ configure: (b) => b.addConfigProvider(app()) });
    });

    it('is registered with its sub-commands and permissions', () => {
        const processor = cli.registry.findProcessor('config')!;
        expect(processor.requiredPermissions).toEqual(['config:read']);
        const subs = Object.fromEntries((processor.processors ?? []).map((p) => [p.command, p.requiredPermissions]));
        expect(subs).toEqual({ list: ['config:read'], get: ['config:read'], set: ['config:write'], reset: ['config:write'] });
    });

    it('config / config list: providers and sections', async () => {
        const { text } = await run(cli, 'config list');
        expect(text.split('\n')[0]).toBe('Default store: In memory, changes are lost on restart');
        expect(text).toContain('server  Server  (read-only)');
        expect(text).toContain('host  Host  (read-only; from Server options, Environment variables)');
        expect(text).toMatch(/app {2}App {2}· In memory\n {2}main +7 setting\(s\) {2}version 0\n {2}main\.extra +1 setting\(s\) {2}version 0/);
        expect(text).toContain('custom  Custom  · In memory');
        expect((await run(cli, 'config')).text).toBe(text);
    });

    it('config get <provider>: every section; <provider>.<section>; <provider>.<section>.<key>', async () => {
        const provider = await run(cli, 'config get app');
        expect(provider.text).toContain('app  App  The app');
        expect(provider.text).toContain('app.main  Main  (version 0)');
        expect(provider.text).toMatch(/limit +5 {2}\[number, default\]/);
        expect(provider.text).toMatch(/apiKey +\(not set\) {2}\[secret, default\]/);
        expect(provider.text).toMatch(/fixed +x {2}\[string, default, read-only\]/);
        expect(provider.text).toMatch(/timeout +30s {2}\[duration, default, restart\]/);

        const section = await run(cli, 'config get app.main.extra');
        expect(section.text).toContain('app.main.extra');
        expect(section.text).toContain('deep.key');

        const entry = await run(cli, 'config get app.main.limit');
        expect(entry.text).toBe(
            [
                'app.main.limit',
                '  Label         limit',
                '  Description   How many',
                '  Type          number',
                '  Value         5',
                '  Default       5',
                '  Source        default',
                '  Origin        default',
                '  Mutable       yes',
                '  Validation    min 1; max 10',
                '  Version       0',
            ].join('\n'),
        );
        expect((await run(cli, 'config get app.main.extra.deep.key')).text).toContain('Value         d');
    });

    it('get: errors for unknown providers, sections and keys, and usage', async () => {
        expect((await run(cli, 'config get nope')).text).toBe('Error: unknown config provider: nope');
        expect((await run(cli, 'config get app.nope')).text).toBe('Error: unknown config section: app.nope');
        expect((await run(cli, 'config get app.main.nope')).text).toBe('Error: unknown setting: app.main.nope');
    });

    it('set: values parsed by type', async () => {
        expect((await run(cli, 'config set app.main.limit 7')).text).toBe('Updated app.main.limit = 7 (version 1)');
        expect((await run(cli, 'config set app.main.tags a,b, c')).text).toBe('Updated app.main.tags = ["a","b","c"] (version 2)');
        expect((await run(cli, 'config set app.main.beta yes')).text).toBe('Updated app.main.beta = true (version 3)');
        expect((await run(cli, 'config set app.main.mode b')).text).toBe('Updated app.main.mode = b (version 4)');
        expect((await run(cli, 'config get app.main.tags')).text).toContain('Value         ["a","b","c"]');
    });

    it('set: a change that needs a restart says so', async () => {
        expect((await run(cli, 'config set app.main.timeout 1m')).text).toMatch(/^Updated app\.main\.timeout = 1m \(version \d+\)\nRestart the server for the change to take effect\.$/);
    });

    it('set: per-key validation errors, parse errors, read-only and unknown', async () => {
        expect((await run(cli, 'config set app.main.limit 50')).text).toBe('Error: validation failed\n  limit: must be at most 10');
        expect((await run(cli, 'config set app.main.limit lots')).text).toBe('Error: validation failed\n  limit: must be a number');
        expect((await run(cli, 'config set app.main.beta maybe')).text).toBe('Error: validation failed\n  beta: must be true or false');
        expect((await run(cli, 'config set app.main.mode z')).text).toBe('Error: validation failed\n  mode: must be one of: a, b');
        expect((await run(cli, 'config set app.main.fixed y')).text).toBe('Error: validation failed\n  fixed: read-only');
        expect((await run(cli, 'config set app.main.ghost 1')).text).toBe('Error: validation failed\n  ghost: unknown setting');
        expect((await run(cli, 'config set server.runtime.pid 1')).text).toBe('Error: config provider server is read-only');
        expect((await run(cli, 'config set app.main 1')).text).toBe('Error: name a setting: <provider>.<section>.<key>');
        expect((await run(cli, 'config set app.main.limit')).text).toContain('usage: config set');
    });

    it('set --expected-version: refused when stale, with the current version (--version from raw API callers too)', async () => {
        const current = (await cli.config.get('app', { hasPermission: () => true })).sections[0].version!;
        expect((await run(cli, 'config set app.main.limit 3 --expected-version 0')).text).toBe(`Error: version conflict (current version ${current})`);
        expect((await run(cli, 'config set app.main.limit 3 --version 0')).text).toBe(`Error: version conflict (current version ${current})`);
        expect((await run(cli, `config set app.main.limit 3 --expected-version ${current}`)).text).toBe(`Updated app.main.limit = 3 (version ${Number(current) + 1})`);
    });

    it('secrets are accepted, never printed', async () => {
        const set = await run(cli, 'config set app.main.apiKey "sk_cmd_secret value"');
        expect(set.text).toMatch(/^Updated app\.main\.apiKey = \(set\) \(version \d+\)$/);
        const all = [await run(cli, 'config get app'), await run(cli, 'config get app.main.apiKey'), await run(cli, 'config list')].map((r) => r.text).join('\n');
        expect(all).not.toContain('sk_cmd_secret');
        expect((await run(cli, 'config get app.main.apiKey')).text).toContain('Value         (set)');
        expect((await run(cli, 'config get app.main.apiKey')).text).not.toContain('Default');
        expect((await run(cli, 'config reset app.main.apiKey')).text).toMatch(/^Reset app\.main\.apiKey = \(not set\)/);
    });

    it('reset: back to the default; free keys removed', async () => {
        await run(cli, 'config set app.main.limit 9');
        expect((await run(cli, 'config reset app.main.limit')).text).toMatch(/^Reset app\.main\.limit = 5 \(version \d+\)$/);
        expect((await run(cli, 'config set custom.custom.motd Hello there')).text).toBe('Updated custom.custom.motd = Hello there (version 1)');
        expect((await run(cli, 'config set custom.custom.retries 3')).text).toBe('Updated custom.custom.retries = 3 (version 2)');
        expect((await run(cli, 'config get custom.custom.retries')).text).toContain('Type          number');
        expect((await run(cli, 'config reset custom.custom.motd')).text).toBe('Reset custom.custom.motd (version 3)');
        expect((await run(cli, 'config reset app.main.limit --expected-version 0')).text).toMatch(/^Error: version conflict/);
        expect((await run(cli, 'config reset')).text).toContain('usage: config reset');
    });

    it('formatConfigValue', () => {
        expect(formatConfigValue({ value: 'x', sensitive: false })).toBe('x');
        expect(formatConfigValue({ value: null, sensitive: false })).toBe('(none)');
        expect(formatConfigValue({ value: { a: 1 }, sensitive: false })).toBe('{"a":1}');
        expect(formatConfigValue({ value: null, sensitive: true, isSet: true })).toBe('(set)');
    });

    it('can be left out: config.command false', () => {
        expect(createCliServer({ config: { command: false } }).registry.findProcessor('config')).toBeUndefined();
    });
});

describe('config list: where changes are saved', () => {
    let dir: string;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-config-cmd-'));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('a JSON file outside the app: its name only, kept across restarts', async () => {
        const cli = createCliServer({ config: { store: new JsonFileConfigStore(path.join(dir, 'qcli-demo-config.json')) } });
        const { text } = await run(cli, 'config list');
        expect(text.split('\n')[0]).toBe('Default store: JSON file (qcli-demo-config.json), kept across restarts');
        expect(text).not.toContain(dir);
    });

    it('a store that does not describe itself: a custom store named after its class', async () => {
        class VaultStore extends InMemoryConfigStore {
            readonly source = 'database' as const;
        }
        const store = new VaultStore();
        (store as { describe?: unknown }).describe = undefined;
        const cli = createCliServer({ config: { store } });
        expect((await run(cli, 'config list')).text.split('\n')[0]).toBe('Default store: Custom store (VaultStore), kept across restarts');
    });
});

describe('config command (protected server)', () => {
    let cli: CliServerResult;
    let users: UsersPluginResult;
    const tokens: Record<string, string> = {};

    beforeAll(async () => {
        cli = createCliServer({ configure: (b) => b.addConfigProvider(app()) });
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

    it('config:read for list and get', async () => {
        expect((await run(cli, 'config list', tokens.runner)).status).toBe(403);
        const ok = await run(cli, 'config get app.main.limit', tokens.reader);
        expect(ok.status).toBe(200);
        expect(ok.text).toContain('Value         5');
    });

    it('config:write for set and reset', async () => {
        const denied = await run(cli, 'config set app.main.limit 2', tokens.reader);
        expect(denied.status).toBe(403);
        expect(denied.body.error).toContain('config:write');
        expect((await run(cli, 'config reset app.main.limit', tokens.reader)).status).toBe(403);
        expect((await run(cli, 'config set app.main.limit 2', tokens.writer)).text).toBe('Updated app.main.limit = 2 (version 1)');
    });

    it('changes are audited with via terminal and the signed-in user', async () => {
        await run(cli, 'config set app.main.apiKey terminal-secret', tokens.writer);
        const entries = await users.auditStore.getEntries({ event: 'config.update' });
        const entry = entries.find((e) => (e.properties as any).changes[0].key === 'apiKey')!;
        expect(entry).toMatchObject({ username: 'writer', target: 'config:app.main' });
        expect((entry.properties as any)).toMatchObject({ via: 'terminal', changes: [{ key: 'apiKey', old: null, new: '***' }] });
        expect(JSON.stringify(entries)).not.toContain('terminal-secret');
    });
});
