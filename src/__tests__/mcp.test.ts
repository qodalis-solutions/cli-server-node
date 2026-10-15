/**
 * MCP endpoint (core server): transport, JSON-RPC, tools from providers
 * (commands, server, filesystem, data explorer, jobs, plugins), permissions,
 * allow/deny lists, origin check, static token and users-plugin protection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCliServer, CliServerOptions } from '../create-cli-server';
import { CliCommandProcessor, CliProcessCommand, ICliCommandProcessor, CliStructuredResponse } from '../abstractions';
import { CliEchoCommandProcessor } from '../processors/cli-echo-command-processor';
import { InMemoryFileStorageProvider, OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import * as nodeFs from 'fs';
import * as nodeOs from 'os';
import * as nodePath from 'path';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { MCP_PROTOCOL_VERSIONS, MCP_SERVER_VERSION, McpToolProvider, mcpObjectSchema } from '../mcp';

const MCP = '/api/qcli/mcp';
const V1 = '/api/v1/qcli';
const ROOT_PASS = 'rootpass1';

// ------------------------------------------------------------- processors

class Proc extends CliCommandProcessor {
    constructor(
        public command: string,
        public description: string,
        init: Partial<ICliCommandProcessor> = {},
        private readonly handler: (c: CliProcessCommand) => Promise<string> = async (c) => JSON.stringify({ chain: c.chainCommands, value: c.value, args: c.args }),
    ) {
        super();
        Object.assign(this, init);
    }
    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.handler(command);
    }
}

class StructuredProc extends Proc {
    constructor(command: string, private readonly response: CliStructuredResponse | (() => Promise<CliStructuredResponse>)) {
        super(command, `structured ${command}`);
    }
    async handleStructuredAsync(): Promise<CliStructuredResponse> {
        return typeof this.response === 'function' ? this.response() : this.response;
    }
}

function weather(): ICliCommandProcessor {
    return new Proc('Weather', 'Weather info', {
        processors: [
            new Proc('current', 'Current weather', {
                parameters: [
                    { name: 'city', description: 'City name', required: true, type: 'string' },
                    { name: 'days', description: 'Days', required: false, type: 'number', defaultValue: 3 },
                    { name: 'metric', description: 'Metric units', required: false, type: 'boolean' },
                    { name: 'tags', description: 'Tags', required: false, type: 'array' },
                    { name: 'when', description: 'Odd type', required: false, type: 'date' },
                ],
            }),
            new Proc('forecast', ''),
        ],
    });
}

function processors(): ICliCommandProcessor[] {
    return [
        new CliEchoCommandProcessor(),
        weather(),
        // parent with parameters → tool itself; children too
        new Proc('db', 'Database', {
            parameters: [{ name: 'verbose', description: 'v', required: false, type: 'boolean' }],
            processors: [new Proc('query', 'Run a query', { valueRequired: true })],
        }),
        new Proc('My.Cmd!', 'Odd name'),
        new Proc('x'.repeat(80), 'Long'),
        new Proc('secret', 'Needs secret:read', { requiredPermissions: ['secret:read'] }),
        new Proc('boom', 'Throws', {}, async () => {
            throw new Error('kaboom');
        }),
        new StructuredProc('obj', { exitCode: 0, outputs: [{ type: 'json', value: { a: 1, nested: { b: true } } }] }),
        new StructuredProc('arr', { exitCode: 0, outputs: [{ type: 'json', value: [1, 2] }] }),
        new StructuredProc('fail', { exitCode: 2, outputs: [{ type: 'text', value: 'bad things', style: 'error' }] }),
        new StructuredProc('mixed', {
            exitCode: 0,
            outputs: [
                { type: 'text', value: 'hello' },
                { type: 'table', headers: ['A', 'B'], rows: [['1', '2'], ['3', '4']] },
                { type: 'list', items: ['x', 'y'] },
                { type: 'key-value', entries: [{ key: 'k', value: 'v' }] },
                { type: 'json', value: { j: 1 } },
            ],
        }),
        // collides with the built-in server_info tool → the built-in wins
        new Proc('server', 'Server', { processors: [new Proc('info', 'Command server info')] }),
    ];
}

function server(options: CliServerOptions = {}) {
    return createCliServer({
        mcp: true,
        ...options,
        configure: (b) => {
            for (const p of processors()) b.addProcessor(p);
            options.configure?.(b);
        },
    });
}

let usersPlugin: UsersPluginResult | undefined;
afterEach(() => {
    usersPlugin?.dispose();
    usersPlugin = undefined;
});

let nextId = 1;
function rpc(app: express.Express, method: string, params?: unknown, headers: Record<string, string> = {}) {
    const body: Record<string, unknown> = { jsonrpc: '2.0', id: nextId++, method };
    if (params !== undefined) body.params = params;
    return raw(app, JSON.stringify(body), headers);
}

function raw(app: express.Express, body: string, headers: Record<string, string> = {}) {
    return request(app).post(MCP).set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').set(headers).send(body);
}

async function listTools(app: express.Express, headers: Record<string, string> = {}): Promise<any[]> {
    const res = await rpc(app, 'tools/list', {}, headers);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    return res.body.result.tools;
}

async function call(app: express.Express, name: string, args?: Record<string, unknown>, headers: Record<string, string> = {}) {
    const res = await rpc(app, 'tools/call', { name, ...(args !== undefined ? { arguments: args } : {}) }, headers);
    expect(res.status).toBe(200);
    return res.body;
}

// ------------------------------------------------------------- transport

describe('MCP: enabling and transport', () => {
    it('is off by default', async () => {
        const { app } = createCliServer({});
        expect((await rpc(app, 'ping')).status).toBe(404);
        expect((await rpc(createCliServer({ mcp: { enabled: false } }).app, 'ping')).status).toBe(404);
        expect((await rpc(createCliServer({ mcp: {} }).app, 'ping')).status).toBe(200);
    });

    it('result.mcp reports the state', () => {
        expect(createCliServer({}).mcp.enabled).toBe(false);
        const s = createCliServer({ mcp: true });
        expect(s.mcp.enabled).toBe(true);
        expect(s.mcp.path).toBe('/api/qcli/mcp');
    });

    it('is mounted under a custom basePath', async () => {
        const { app } = createCliServer({ mcp: true, basePath: '/custom' });
        const res = await request(app).post('/custom/mcp').set('Content-Type', 'application/json').send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
        expect(res.body.result).toEqual({});
    });

    it('GET and DELETE → 405 with Allow: POST', async () => {
        const { app } = server();
        for (const res of [await request(app).get(MCP), await request(app).delete(MCP), await request(app).put(MCP)]) {
            expect(res.status).toBe(405);
            expect(res.headers['allow']).toBe('POST');
        }
    });

    it('responds with JSON, without Mcp-Session-Id', async () => {
        const res = await rpc(server().app, 'ping');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(res.headers['mcp-session-id']).toBeUndefined();
        expect(res.body).toEqual({ jsonrpc: '2.0', id: expect.any(Number), result: {} });
    });

    it('notifications → 202 with an empty body', async () => {
        const { app } = server();
        const res = await raw(app, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
        expect(res.status).toBe(202);
        expect(res.text).toBe('');
        // a client response is accepted the same way
        expect((await raw(app, JSON.stringify({ jsonrpc: '2.0', id: 5, result: {} }))).status).toBe(202);
    });

    it('JSON-RPC errors (HTTP 200): parse -32700, invalid -32600, unknown method -32601, bad params -32602', async () => {
        const { app } = server();
        const parse = await raw(app, '{not json');
        expect(parse.status).toBe(200);
        expect(parse.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: expect.any(String) } });

        for (const body of ['[1,2]', '"x"', JSON.stringify({ id: 1, method: 'ping' }), JSON.stringify({ jsonrpc: '2.0', id: 1 }), JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'ping' }), JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }])]) {
            const res = await raw(app, body);
            expect(res.status, body).toBe(200);
            expect(res.body.error.code, body).toBe(-32600);
        }

        const unknown = await rpc(app, 'resources/list');
        expect(unknown.body.error.code).toBe(-32601);
        const badParams = await rpc(app, 'tools/list', [1]);
        expect(badParams.body.error.code).toBe(-32602);
    });

    it('origin: allowed and same-origin pass, others → 403', async () => {
        const { app } = server({ allowedOrigins: ['http://good.test'] });
        expect((await rpc(app, 'ping', undefined, { Origin: 'http://evil.test' })).status).toBe(403);
        expect((await rpc(app, 'ping', undefined, { Origin: 'http://good.test' })).status).toBe(200);
        expect((await rpc(app, 'ping', undefined, { Host: 'me.test:8080', Origin: 'http://me.test:8080' })).status).toBe(200);
        expect((await rpc(app, 'ping')).status).toBe(200); // no Origin (non-browser client)
        expect((await request(app).get(MCP).set('Origin', 'http://evil.test')).status).toBe(403);
    });
});

// ------------------------------------------------------------- methods

describe('MCP: initialize and ping', () => {
    it('echoes a supported protocol version, otherwise the newest', async () => {
        const { app } = server({ mcp: { instructions: 'Use the tools.' } });
        for (const v of ['2025-06-18', '2025-03-26']) {
            expect((await rpc(app, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } })).body.result.protocolVersion).toBe(v);
        }
        const res = await rpc(app, 'initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
        expect(res.body.result).toEqual({
            protocolVersion: MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'qodalis-cli-server', version: MCP_SERVER_VERSION },
            instructions: 'Use the tools.',
        });
        expect(MCP_PROTOCOL_VERSIONS).toContain('2025-06-18');
        expect(MCP_PROTOCOL_VERSIONS).toContain('2025-03-26');
    });

    it('omits instructions when not configured; missing protocolVersion → -32602', async () => {
        const { app } = server();
        const res = await rpc(app, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
        expect(res.body.result.instructions).toBeUndefined();
        expect((await rpc(app, 'initialize', {})).body.error.code).toBe(-32602);
    });

    it('ping → {}', async () => {
        expect((await rpc(server().app, 'ping')).body.result).toEqual({});
    });
});

// ------------------------------------------------------------- tools/list

describe('MCP: tools/list', () => {
    it('command tools: naming rules, leaf/parameter/value rules', async () => {
        const tools = await listTools(server().app);
        const names = tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['echo', 'weather_current', 'weather_forecast', 'db', 'db_query', 'my-cmd-', 'x'.repeat(64), 'secret', 'server_info']));
        // a parent without parameters/value is not a tool
        expect(names).not.toContain('weather');
        expect(names).not.toContain('server');
        for (const name of names) expect(name).toMatch(/^[a-z0-9_-]{1,64}$/);
        expect(new Set(names).size).toBe(names.length);
        // server_info is the built-in tool (wins over the 'server info' command)
        const info = tools.find((t) => t.name === 'server_info');
        expect(info.description).not.toBe('Command server info');
        expect(info.annotations).toEqual({ readOnlyHint: true });
    });

    it('inputSchema maps parameters and the positional value', async () => {
        const tools = await listTools(server().app);
        const current = tools.find((t) => t.name === 'weather_current');
        expect(current.description).toBe('Current weather');
        expect(current.inputSchema).toEqual({
            type: 'object',
            properties: {
                city: { type: 'string', description: 'City name' },
                days: { type: 'number', description: 'Days', default: 3 },
                metric: { type: 'boolean', description: 'Metric units' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
                when: { type: 'string', description: 'Odd type' },
            },
            required: ['city'],
            additionalProperties: false,
        });
        const echo = tools.find((t) => t.name === 'echo');
        expect(echo.inputSchema.properties.value).toMatchObject({ type: 'string' });
        expect(echo.inputSchema.required).toEqual(['value']);
        const query = tools.find((t) => t.name === 'db_query');
        expect(query.inputSchema.required).toEqual(['value']);
        const forecast = tools.find((t) => t.name === 'weather_forecast');
        expect(forecast.description).toBe("Run 'Weather forecast'");
        expect(forecast.inputSchema).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
    });

    it('allow-list (trailing *) then deny-list', async () => {
        const allow = await listTools(server({ mcp: { tools: ['weather_*', 'echo'] } }).app);
        expect(allow.map((t) => t.name).sort()).toEqual(['echo', 'weather_current', 'weather_forecast']);
        const both = await listTools(server({ mcp: { tools: ['weather_*'], exclude: ['weather_forecast'] } }).app);
        expect(both.map((t) => t.name)).toEqual(['weather_current']);
        const deny = await listTools(server({ mcp: { exclude: ['server_*', 'db*'] } }).app);
        expect(deny.map((t) => t.name)).not.toContain('server_info');
        expect(deny.map((t) => t.name)).not.toContain('db_query');
        // excluded tools cannot be called either
        const app = server({ mcp: { exclude: ['echo'] } }).app;
        expect((await call(app, 'echo', { value: 'x' })).error).toEqual({ code: -32602, message: 'Unknown tool: echo' });
    });

    it('tools are rebuilt on every request (new registrations show up)', async () => {
        const s = server();
        expect((await listTools(s.app)).map((t) => t.name)).not.toContain('later');
        s.registry.register(new Proc('later', 'Registered later'));
        expect((await listTools(s.app)).map((t) => t.name)).toContain('later');
    });
});

// ------------------------------------------------------------- tools/call

describe('MCP: tools/call', () => {
    it('runs the command through the executor (value, args, chain)', async () => {
        const app = server().app;
        const echo = await call(app, 'echo', { value: 'hello world' });
        expect(echo.result).toEqual({ content: [{ type: 'text', text: 'hello world' }], isError: false });

        const current = await call(app, 'weather_current', { city: 'Oslo', days: 2, metric: true, tags: ['a', 'b'] });
        expect(current.result.isError).toBe(false);
        expect(JSON.parse(current.result.content[0].text)).toEqual({ chain: ['current'], args: { city: 'Oslo', days: 2, metric: true, tags: ['a', 'b'] } });

        const query = await call(app, 'db_query', { value: 'select 1' });
        expect(JSON.parse(query.result.content[0].text)).toEqual({ chain: ['query'], value: 'select 1', args: {} });
    });

    it('uses the same executor as /execute (disabled commands stay disabled)', async () => {
        const s = server();
        s.executor.addFilter({ isAllowed: (p) => p.command !== 'echo' });
        const res = await call(s.app, 'echo', { value: 'x' });
        expect(res.result.isError).toBe(true);
        expect(res.result.content[0].text).toMatch(/disabled/);
    });

    it('structuredContent only for exactly one json object output', async () => {
        const app = server().app;
        const obj = await call(app, 'obj');
        expect(obj.result.structuredContent).toEqual({ a: 1, nested: { b: true } });
        expect(JSON.parse(obj.result.content[0].text)).toEqual({ a: 1, nested: { b: true } });
        const arr = await call(app, 'arr');
        expect(arr.result.structuredContent).toBeUndefined();
        const mixed = await call(app, 'mixed');
        expect(mixed.result.structuredContent).toBeUndefined();
        expect(mixed.result.content[0].text).toBe('hello\nA | B\n1 | 2\n3 | 4\nx\ny\nk: v\n{\n  "j": 1\n}');
    });

    it('isError for a non-zero exit code and for exceptions (not a JSON-RPC error)', async () => {
        const app = server().app;
        const fail = await call(app, 'fail');
        expect(fail.result).toEqual({ content: [{ type: 'text', text: 'bad things' }], isError: true });
        const boom = await call(app, 'boom');
        expect(boom.error).toBeUndefined();
        expect(boom.result.isError).toBe(true);
        expect(boom.result.content[0].text).toContain('kaboom');
    });

    it('unknown tool and invalid arguments → -32602', async () => {
        const app = server().app;
        expect((await call(app, 'nope')).error).toEqual({ code: -32602, message: 'Unknown tool: nope' });
        const cases: [string, Record<string, unknown>, RegExp][] = [
            ['weather_current', {}, /missing required argument 'city'/],
            ['weather_current', { city: 3 }, /'city' must be a string/],
            ['weather_current', { city: 'x', days: 'two' }, /'days' must be a number/],
            ['weather_current', { city: 'x', metric: 'yes' }, /'metric' must be a boolean/],
            ['weather_current', { city: 'x', tags: [1] }, /'tags' must be an array of strings/],
            ['weather_current', { city: 'x', extra: 1 }, /unknown argument 'extra'/],
            ['echo', {}, /missing required argument 'value'/],
        ];
        for (const [name, args, reason] of cases) {
            const res = await call(app, name, args);
            expect(res.error.code, JSON.stringify(args)).toBe(-32602);
            expect(res.error.message).toMatch(reason);
        }
        expect((await rpc(app, 'tools/call', { name: 'echo', arguments: [1] })).body.error.code).toBe(-32602);
        expect((await rpc(app, 'tools/call', {})).body.error.code).toBe(-32602);
    });

    it('server_info returns version, capabilities, features and commands', async () => {
        const res = await call(server().app, 'server_info');
        const info = res.result.structuredContent;
        expect(info).toMatchObject({ name: 'qodalis-cli-server', version: MCP_SERVER_VERSION });
        expect(info.capabilities).toMatchObject({ streaming: true, shell: false });
        expect(info.features).toEqual(expect.arrayContaining(['commands', 'mcp']));
        expect(info.commands).toEqual(expect.arrayContaining(['echo', 'Weather']));
    });
});

// ------------------------------------------------------------- providers

describe('MCP: tool providers', () => {
    it('host/plugin providers add tools; built-in and earlier tools win collisions; invalid names skipped', async () => {
        const s = server();
        const provider = (name: string, tools: string[]): McpToolProvider => ({
            name,
            getTools: () =>
                tools.map((t) => ({
                    name: t,
                    description: `${name}:${t}`,
                    inputSchema: mcpObjectSchema({ n: { type: 'integer' } }, []),
                    requiredPermissions: [],
                    annotations: { idempotentHint: true },
                    call: async (args) => ({ text: `${name} got ${args.n ?? '-'}`, structured: { by: name }, isError: false }),
                })),
        });
        s.mcp.addProvider(provider('first', ['custom', 'echo', 'server_info', 'Bad Name']));
        s.builder.addMcpToolProvider(provider('second', ['custom', 'other']));
        const tools = await listTools(s.app);
        const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
        expect(byName.custom.description).toBe('first:custom');
        expect(byName.custom.annotations).toEqual({ idempotentHint: true });
        expect(byName.other.description).toBe('second:other');
        expect(byName.echo.description).not.toBe('first:echo'); // command tools come before plugins
        expect(byName.server_info.description).not.toBe('first:server_info');
        expect(byName['Bad Name']).toBeUndefined();

        const res = await call(s.app, 'custom', { n: 4 });
        expect(res.result).toEqual({ content: [{ type: 'text', text: 'first got 4' }], isError: false, structuredContent: { by: 'first' } });
        expect((await call(s.app, 'custom', { n: 1.5 })).error.message).toMatch(/must be an integer/);
    });

    it('providers contributed by a mounted plugin', async () => {
        const s = server();
        s.mountPlugin({
            prefix: '/plugin',
            router: express.Router(),
            mcpProviders: [
                {
                    name: 'p',
                    getTools: () => [
                        { name: 'plugin_tool', description: 'd', inputSchema: mcpObjectSchema(), requiredPermissions: [], call: async () => ({ text: 'ok', isError: false }) },
                    ],
                },
            ],
        });
        expect((await call(s.app, 'plugin_tool')).result.content[0].text).toBe('ok');
    });

    it('a provider tool that throws → isError result', async () => {
        const s = server();
        s.mcp.addProvider({
            name: 'thrower',
            getTools: () => [
                { name: 'throws', description: 'd', inputSchema: mcpObjectSchema(), requiredPermissions: [], call: async () => { throw new Error('nope!'); } },
            ],
        });
        const res = await call(s.app, 'throws');
        expect(res.result.isError).toBe(true);
        expect(res.result.content[0].text).toContain('nope!');
    });

    it('filesystem tools use the configured storage provider', async () => {
        const fs = new InMemoryFileStorageProvider();
        const s = server({ configure: (b) => b.setFileStorageProvider(fs) });
        const tools = await listTools(s.app);
        const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
        expect(Object.keys(byName)).toEqual(expect.arrayContaining(['fs_list', 'fs_stat', 'fs_read', 'fs_write', 'fs_mkdir', 'fs_delete']));
        expect(byName.fs_read.annotations).toEqual({ readOnlyHint: true });
        expect(byName.fs_delete.annotations).toEqual({ destructiveHint: true });
        expect(byName.fs_read.inputSchema.properties.maxBytes).toMatchObject({ type: 'integer', default: 262144 });

        expect((await call(s.app, 'fs_mkdir', { path: '/docs/sub' })).result.isError).toBe(false);
        const write = await call(s.app, 'fs_write', { path: '/docs/a.txt', content: 'héllo world' });
        expect(write.result.isError).toBe(false);
        expect((await call(s.app, 'fs_read', { path: '/docs/a.txt' })).result.content[0].text).toBe('héllo world');
        const truncated = await call(s.app, 'fs_read', { path: '/docs/a.txt', maxBytes: 2 });
        expect(truncated.result.content[0].text).toMatch(/^h\n\[truncated: 1 of 12 bytes\]$/);
        const list = await call(s.app, 'fs_list', { path: '/docs' });
        expect(list.result.structuredContent.entries.map((e: any) => e.name).sort()).toEqual(['a.txt', 'sub']);
        const stat = await call(s.app, 'fs_stat', { path: '/docs/a.txt' });
        expect(stat.result.structuredContent).toMatchObject({ name: 'a.txt', type: 'file', size: 12 });

        await fs.writeFile('/docs/bin.dat', Buffer.from([0x00, 0xff, 0x10]));
        const bin = await call(s.app, 'fs_read', { path: '/docs/bin.dat' });
        expect(bin.result.isError).toBe(true);
        expect(bin.result.content[0].text).toMatch(/^binary file, \d+ bytes$/);

        const missing = await call(s.app, 'fs_read', { path: '/nope.txt' });
        expect(missing.result.isError).toBe(true);
        const nonEmpty = await call(s.app, 'fs_delete', { path: '/docs' });
        expect(nonEmpty.result.isError).toBe(true);
        expect((await call(s.app, 'fs_delete', { path: '/docs', recursive: true })).result.isError).toBe(false);
        expect(await fs.exists('/docs')).toBe(false);
    });

    it('fs tools go through the OS provider path validator (outside the allow-list → isError)', async () => {
        const root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'qcli-mcp-')));
        const outside = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'qcli-out-')));
        nodeFs.writeFileSync(nodePath.join(outside, 'secret.txt'), 'top secret');
        try {
            const s = server({ configure: (b) => b.setFileStorageProvider(new OsFileStorageProvider({ allowedPaths: [root] })) });
            const inside = nodePath.join(root, 'a.txt');
            expect((await call(s.app, 'fs_write', { path: inside, content: 'ok' })).result.isError).toBe(false);
            expect((await call(s.app, 'fs_read', { path: inside })).result.content[0].text).toBe('ok');
            for (const [tool, args] of [
                ['fs_read', { path: nodePath.join(outside, 'secret.txt') }],
                ['fs_read', { path: `${root}/../${nodePath.basename(outside)}/secret.txt` }],
                ['fs_list', { path: outside }],
                ['fs_write', { path: nodePath.join(outside, 'x.txt'), content: 'x' }],
                ['fs_delete', { path: outside, recursive: true }],
            ] as const) {
                const res = await call(s.app, tool, args);
                expect(res.result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
                expect(res.result.content[0].text).not.toContain('top secret');
            }
            expect(nodeFs.existsSync(nodePath.join(outside, 'x.txt'))).toBe(false);
            expect(nodeFs.existsSync(nodePath.join(outside, 'secret.txt'))).toBe(true);
        } finally {
            nodeFs.rmSync(root, { recursive: true, force: true });
            nodeFs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('annotations of the feature tools', async () => {
        const s = server({ configure: (b) => b.setFileStorageProvider(new InMemoryFileStorageProvider()) });
        s.mountPlugin(new CliJobsBuilder().build());
        const tools = Object.fromEntries((await listTools(s.app)).map((t) => [t.name, t.annotations]));
        for (const n of ['server_info', 'fs_list', 'fs_stat', 'fs_read', 'jobs_list', 'jobs_get', 'jobs_history']) expect(tools[n], n).toEqual({ readOnlyHint: true });
        for (const n of ['fs_delete', 'jobs_stop', 'jobs_cancel']) expect(tools[n], n).toEqual({ destructiveHint: true });
        for (const n of ['fs_write', 'fs_mkdir', 'jobs_trigger', 'jobs_pause', 'jobs_resume', 'echo']) expect(tools[n], n).toBeUndefined();
    });

    it('no filesystem/data/jobs tools when those features are off', async () => {
        const names = (await listTools(server().app)).map((t) => t.name);
        expect(names.some((n) => n.startsWith('fs_') || n.startsWith('data_') || n.startsWith('jobs_'))).toBe(false);
    });

    it('data explorer tools use the same executor', async () => {
        const s = server({
            configure: (b) =>
                b.addDataExplorerProvider(
                    {
                        executeAsync: async (ctx) => {
                            if (ctx.query === 'bad') throw new Error('syntax error');
                            return {
                                success: true, source: 'mem', language: DataExplorerLanguage.Sql, defaultOutputFormat: DataExplorerOutputFormat.Table,
                                executionTime: 1, columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b'], [3, 'c']], rowCount: 3, truncated: false,
                            };
                        },
                        getSchemaAsync: async () => ({ source: 'mem', tables: [{ name: 't', type: 'table', columns: [] }] }) as any,
                    },
                    { name: 'mem', description: 'Memory', language: DataExplorerLanguage.Sql, defaultOutputFormat: DataExplorerOutputFormat.Table, maxRows: 2 },
                ),
        });
        const sources = await call(s.app, 'data_sources');
        expect(sources.result.structuredContent.sources[0]).toMatchObject({ name: 'mem' });
        const schema = await call(s.app, 'data_schema', { source: 'mem' });
        expect(schema.result.structuredContent.tables[0].name).toBe('t');
        expect((await call(s.app, 'data_schema', { source: 'zzz' })).result.isError).toBe(true);
        const q = await call(s.app, 'data_query', { source: 'mem', query: 'select', parameters: { a: 1 } });
        expect(q.result.isError).toBe(false);
        expect(q.result.content[0].text).toBe('id | name\n1 | a\n2 | b\n(2 rows, truncated)'); // maxRows applied
        const bad = await call(s.app, 'data_query', { source: 'mem', query: 'bad' });
        expect(bad.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'syntax error' }] });
    });

    it('jobs tools when the jobs plugin is mounted', async () => {
        const s = server();
        let runs = 0;
        const jobs = new CliJobsBuilder()
            .addJob({ executeAsync: async () => { runs++; } } as any, { name: 'tick', description: 'Tick', interval: '1h' })
            .build();
        s.mountPlugin(jobs);
        const names = (await listTools(s.app)).map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['jobs_list', 'jobs_get', 'jobs_history', 'jobs_trigger', 'jobs_pause', 'jobs_resume', 'jobs_stop', 'jobs_cancel']));
        const list = await call(s.app, 'jobs_list');
        const id = list.result.structuredContent.jobs[0].id;
        expect((await call(s.app, 'jobs_get', { id })).result.structuredContent.name).toBe('tick');
        expect((await call(s.app, 'jobs_get', { id: 'missing' })).result.isError).toBe(true);
        expect((await call(s.app, 'jobs_trigger', { id: 'missing' })).result.isError).toBe(true);
        expect((await call(s.app, 'jobs_trigger', { id })).result.isError).toBe(false);
        await new Promise((r) => setTimeout(r, 50));
        expect(runs).toBe(1);
        const history = await call(s.app, 'jobs_history', { id, limit: 5 });
        expect(history.result.structuredContent.limit).toBe(5);
        await jobs.scheduler.stop();
    });
});

// ------------------------------------------------------------- auth

describe('MCP: authentication', () => {
    it('without an auth provider and token: open like /execute', async () => {
        expect((await call(server().app, 'echo', { value: 'x' })).result.isError).toBe(false);
    });

    it('static token without an auth provider (constant-time compare)', async () => {
        const { app } = server({ mcp: { token: 's3cret' } });
        const none = await rpc(app, 'ping');
        expect(none.status).toBe(401);
        expect(none.body).toEqual({ error: 'unauthorized' });
        expect((await rpc(app, 'ping', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401);
        expect((await rpc(app, 'ping', undefined, { Authorization: 's3cret' })).status).toBe(401);
        const ok = await rpc(app, 'ping', undefined, { Authorization: 'Bearer s3cret' });
        expect(ok.status).toBe(200);
        expect(ok.body.result).toEqual({});
    });

    async function protectedServer(options: CliServerOptions = {}) {
        const s = server(options);
        usersPlugin = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build();
        await usersPlugin.ready;
        s.mountPlugin(usersPlugin);
        const login = async (username: string, password: string) => {
            const res = await request(s.app).post(`${V1}/sessions`).send({ username, password });
            expect(res.status).toBe(201);
            return res.body.token as string;
        };
        const root = await login('root', ROOT_PASS);
        const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
        const createUser = async (name: string, groups: string[]) => {
            await request(s.app).post(`${V1}/users`).set(bearer(root)).send({ name, email: `${name}@example.com`, password: `${name}pw`, groups }).expect(201);
            return login(name, `${name}pw`);
        };
        return { s, root, bearer, login, createUser };
    }

    it('with the users plugin: 401 without credentials, 403 without commands:execute', async () => {
        const { s, root, bearer, createUser } = await protectedServer({ mcp: { token: 'ignored' } });
        const none = await rpc(s.app, 'ping');
        expect(none.status).toBe(401);
        expect(none.body.error).toBeDefined();
        // the static token is ignored when an auth provider protects the server
        expect((await rpc(s.app, 'ping', undefined, { Authorization: 'Bearer ignored' })).status).toBe(401);

        await request(s.app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'nothing', permissions: ['files:read'] }).expect(201);
        const weak = await createUser('weak', ['nothing']);
        const denied = await rpc(s.app, 'ping', undefined, bearer(weak));
        expect(denied.status).toBe(403);
        expect(denied.body.error).toMatch(/commands:execute/);

        expect((await rpc(s.app, 'ping', undefined, bearer(root))).body.result).toEqual({});
    });

    it('tools/list and tools/call are filtered by the caller permissions', async () => {
        const fs = new InMemoryFileStorageProvider();
        const { s, root, bearer, createUser } = await protectedServer({ configure: (b) => b.setFileStorageProvider(fs) });
        const alice = await createUser('alice', ['users']); // commands:execute only
        const aliceTools = (await listTools(s.app, bearer(alice))).map((t) => t.name);
        expect(aliceTools).toContain('echo');
        expect(aliceTools).toContain('server_info');
        expect(aliceTools).not.toContain('secret');
        expect(aliceTools.some((n) => n.startsWith('fs_'))).toBe(false);
        expect((await call(s.app, 'secret', {}, bearer(alice))).error).toEqual({ code: -32602, message: 'Unknown tool: secret' });
        expect((await call(s.app, 'fs_write', { path: '/a', content: 'x' }, bearer(alice))).error.code).toBe(-32602);

        await request(s.app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'readers', permissions: ['secret:read', 'files:read'] }).expect(201);
        await request(s.app).post(`${V1}/groups/readers/members/alice`).set(bearer(root)).expect(204);
        const after = (await listTools(s.app, bearer(alice))).map((t) => t.name);
        expect(after).toContain('secret');
        expect(after).toEqual(expect.arrayContaining(['fs_list', 'fs_read', 'fs_stat']));
        expect(after).not.toContain('fs_write');
        expect((await call(s.app, 'secret', {}, bearer(alice))).result.isError).toBe(false);

        const rootTools = (await listTools(s.app, bearer(root))).map((t) => t.name);
        expect(rootTools).toEqual(expect.arrayContaining(['secret', 'fs_write', 'fs_delete']));
    });

    it('data and jobs tools are visible per permission (data:query, jobs:read, jobs:manage)', async () => {
        const { s, root, bearer, createUser } = await protectedServer({
            configure: (b) =>
                b.addDataExplorerProvider(
                    { executeAsync: async () => ({ success: true, source: 'mem', language: DataExplorerLanguage.Sql, defaultOutputFormat: DataExplorerOutputFormat.Table, executionTime: 0, columns: ['x'], rows: [[1]], rowCount: 1, truncated: false }) },
                    { name: 'mem', description: 'Memory', language: DataExplorerLanguage.Sql, defaultOutputFormat: DataExplorerOutputFormat.Table },
                ),
        });
        s.mountPlugin(new CliJobsBuilder().build());
        const names = async (token: string) => (await listTools(s.app, bearer(token))).map((t) => t.name);

        const plain = await createUser('plain', ['users']);
        const p = await names(plain);
        expect(p.some((n) => n.startsWith('data_') || n.startsWith('jobs_'))).toBe(false);
        expect((await call(s.app, 'data_query', { source: 'mem', query: 'q' }, bearer(plain))).error.code).toBe(-32602);

        await request(s.app).post(`${V1}/groups`).set(bearer(root)).send({ name: 'analysts', permissions: ['commands:execute', 'data:query', 'jobs:read'] }).expect(201);
        const analyst = await createUser('analyst', ['analysts']);
        const a = await names(analyst);
        expect(a).toEqual(expect.arrayContaining(['data_sources', 'data_schema', 'data_query', 'jobs_list', 'jobs_get', 'jobs_history']));
        expect(a).not.toContain('jobs_trigger');
        expect((await call(s.app, 'data_query', { source: 'mem', query: 'q' }, bearer(analyst))).result.content[0].text).toBe('x\n1\n(1 row)');
        expect((await call(s.app, 'jobs_trigger', { id: 'x' }, bearer(analyst))).error.code).toBe(-32602);

        const r = await names(root);
        expect(r).toEqual(expect.arrayContaining(['jobs_trigger', 'jobs_pause', 'jobs_resume', 'jobs_stop', 'jobs_cancel']));
    });

    it('API tokens authenticate MCP; scoped tokens see fewer tools; revoked tokens → 401', async () => {
        const { s, root, bearer } = await protectedServer();
        const full = (await request(s.app).post(`${V1}/tokens`).set(bearer(root)).send({ name: 'mcp' }).expect(201)).body;
        const scoped = (await request(s.app).post(`${V1}/tokens`).set(bearer(root)).send({ name: 'scoped', permissions: ['commands:execute'] }).expect(201)).body;

        expect((await listTools(s.app, bearer(full.token))).map((t) => t.name)).toContain('secret');
        const scopedTools = (await listTools(s.app, bearer(scoped.token))).map((t) => t.name);
        expect(scopedTools).toContain('echo');
        expect(scopedTools).not.toContain('secret');
        expect((await call(s.app, 'echo', { value: 'via token' }, bearer(scoped.token))).result.content[0].text).toBe('via token');

        await request(s.app).delete(`${V1}/tokens/${full.apiToken.id}`).set(bearer(root)).expect(204);
        expect((await rpc(s.app, 'ping', undefined, bearer(full.token))).status).toBe(401);
    });

    it('origin is checked before authentication', async () => {
        const { s, root, bearer } = await protectedServer({ allowedOrigins: ['http://good.test'] });
        expect((await rpc(s.app, 'ping', undefined, { ...bearer(root), Origin: 'http://evil.test' })).status).toBe(403);
        expect((await rpc(s.app, 'ping', undefined, { ...bearer(root), Origin: 'http://good.test' })).status).toBe(200);
    });
});
