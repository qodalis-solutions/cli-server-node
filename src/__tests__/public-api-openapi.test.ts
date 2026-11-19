/**
 * The public OpenAPI document (the host's, with the bearer scheme, a top-level security
 * requirement and servers added where missing) and Swagger UI for it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import http from 'http';
import path from 'path';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { CliPublicApiBuilder, PublicApiPluginResult, PublicApiUsers } from '@qodalis/cli-server-plugin-public-api';
import { ROOT_PASS, auth } from './users-test-helpers';

const FIXTURE = path.join(__dirname, 'fixtures', 'public-openapi.json');
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const QCLI_TOKEN = {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'qcli_pat',
    description: 'API token (qcli_pat_…), sent as Authorization: Bearer <token>',
};

interface Harness {
    cli: CliServerResult;
    users: UsersPluginResult;
    api: PublicApiPluginResult;
}

const disposables: Array<() => void> = [];

afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

async function start(configure: (b: CliPublicApiBuilder) => void = (b) => b.setOpenApi(fixture())): Promise<Harness> {
    const cli = createCliServer();
    cli.builder.addPermissions([{ name: 'rates:read', description: 'Official exchange rates', group: 'Rates' }]);
    const users = new CliUsersBuilder().setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4 }).build();
    await users.ready;
    cli.mountPlugin(users);
    const builder = new CliPublicApiBuilder().setUsers(users);
    configure(builder);
    const api = builder.build();
    cli.mountPlugin(api);
    disposables.push(() => {
        users.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return { cli, users, api };
}

/** Requests through a listening server, so the Host header is `127.0.0.1:<port>`. */
async function listen(h: Harness): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer(h.cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    disposables.push(() => {
        server.closeAllConnections?.();
        server.close();
    });
    return { server, port: (server.address() as { port: number }).port };
}

describe('public OpenAPI document', () => {
    it("document is the host's with the additions", async () => {
        const h = await start();
        const { server, port } = await listen(h);
        const res = await request(server).get('/qcli/api/openapi.json');
        expect(res.status).toBe(200);
        const doc = res.body;
        expect(doc.info).toEqual({ title: 'RateBell API', version: '1.0.0' });
        expect(Object.keys(doc.paths)).toEqual(['/v1/rates', '/v1/ping']);
        expect(doc.components.securitySchemes.qcliToken).toEqual(QCLI_TOKEN);
        expect(doc.security).toEqual([{ qcliToken: [] }]);
        expect(doc.servers).toEqual([{ url: `http://127.0.0.1:${port}` }]);
        // the host's x-required-permission is kept; none is added where the host set none
        expect(doc.paths['/v1/rates'].get['x-required-permission']).toBe('rates:read');
        expect(doc.paths['/v1/ping'].get).not.toHaveProperty('x-required-permission');
        expect(doc.paths['/v1/ping'].get).not.toHaveProperty('x-host-token-only');
    });

    it('host values win', async () => {
        const own = {
            ...fixture(),
            servers: [{ url: 'https://api.example.com' }],
            security: [{ apiKey: [] }],
            components: { securitySchemes: { qcliToken: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
        };
        const h = await start((b) => b.setOpenApi(own));
        const doc = (await request(h.cli.app).get('/qcli/api/openapi.json')).body;
        expect(doc.servers).toEqual([{ url: 'https://api.example.com' }]);
        expect(doc.security).toEqual([{ apiKey: [] }]);
        expect(doc.components.securitySchemes.qcliToken).toEqual({ type: 'apiKey', in: 'header', name: 'X-Key' });
    });

    it('keeps the host\'s other security schemes', async () => {
        const own = { ...fixture(), components: { schemas: { Rate: { type: 'object' } }, securitySchemes: { other: { type: 'http', scheme: 'basic' } } } };
        const h = await start((b) => b.setOpenApi(own));
        const doc = (await request(h.cli.app).get('/qcli/api/openapi.json')).body;
        expect(doc.components.schemas).toEqual({ Rate: { type: 'object' } });
        expect(doc.components.securitySchemes).toEqual({ other: { type: 'http', scheme: 'basic' }, qcliToken: QCLI_TOKEN });
    });

    it('serverUrl option', async () => {
        const h = await start((b) => b.setOpenApi(fixture()).setServerUrl('https://api.ratebell.app'));
        const doc = (await request(h.cli.app).get('/qcli/api/openapi.json')).body;
        expect(doc.servers).toEqual([{ url: 'https://api.ratebell.app' }]);
    });

    it('headers', async () => {
        const h = await start();
        const res = await request(h.cli.app).get('/qcli/api/openapi.json');
        expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('ignores credentials', async () => {
        const h = await start();
        await h.users.groupStore.createGroup({ name: 'customers', permissions: ['rates:read'] });
        const alice = await h.users.userStore.createUser({ name: 'alice', email: 'alice@example.com', groups: ['customers'] });
        const { token } = await h.users.apiTokens.create(alice.id, { name: 'site', audience: 'host', permissions: ['rates:read'] });
        for (const bearer of [token, 'garbage', 'qcli_pat_unknown']) {
            const res = await request(h.cli.app).get('/qcli/api/openapi.json').set(auth(bearer));
            expect(res.status, bearer).toBe(200);
        }
    });

    it('swagger page points at this document only', async () => {
        const h = await start();
        for (const p of ['/qcli/api/swagger', '/qcli/api/swagger/']) {
            const res = await request(h.cli.app).get(p);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/^text\/html/);
            expect(res.text).toContain('/qcli/api/openapi.json');
            expect(res.text).toContain('swagger-ui-bundle.js');
            expect(res.text).toContain('persistAuthorization: false');
            expect(res.text).toContain('tryItOutEnabled: true');
            expect(res.text).toContain('<title>RateBell API</title>');
            expect(res.text).not.toMatch(/urls\s*:/);
        }
        const bundle = await request(h.cli.app).get('/qcli/api/swagger/assets/swagger-ui-bundle.js');
        expect(bundle.status).toBe(200);
        expect((await request(h.cli.app).get('/qcli/api/swagger/assets/swagger-ui.css')).status).toBe(200);
        expect((await request(h.cli.app).get('/qcli/api/swagger/assets/index.html')).status).toBe(404);
        expect((await request(h.cli.app).get('/qcli/api/swagger/assets/..%2Fpackage.json')).status).toBe(404);
    });

    it('the title is escaped in the swagger page', async () => {
        const h = await start((b) => b.setOpenApi({ ...fixture(), info: { title: '</title><script>x</script>', version: '1' } }));
        const res = await request(h.cli.app).get('/qcli/api/swagger');
        expect(res.text).not.toContain('<script>x</script>');
        expect(res.text).toContain('&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;');
    });

    it('other paths under the base are not handled', async () => {
        const h = await start();
        expect((await request(h.cli.app).get('/qcli/api/other')).status).toBe(404);
        expect((await request(h.cli.app).post('/qcli/api/openapi.json')).status).toBe(404);
    });

    it('custom base path', async () => {
        const h = await start((b) => b.setOpenApi(fixture()).setBasePath('/developers/api'));
        expect((await request(h.cli.app).get('/developers/api/openapi.json')).status).toBe(200);
        expect((await request(h.cli.app).get('/qcli/api/openapi.json')).status).toBe(404);
        const page = await request(h.cli.app).get('/developers/api/swagger');
        expect(page.text).toContain('/developers/api/openapi.json');
        expect(h.api.portalSection).toEqual({ kind: 'api', title: 'API reference', basePath: '/developers/api' });
    });

    it.each(['', '/', 'api', '/api/'])('invalid base path %j', (value) => {
        const users: PublicApiUsers = {
            requireHostToken: () => (_req, _res, next) => next(),
            setTokenUsageProvider: () => undefined,
            apiTokens: { list: async () => [] },
            getUser: async () => undefined,
        };
        const builder = new CliPublicApiBuilder().setUsers(users).setBasePath(value);
        expect(() => builder.build()).toThrow(`invalid public-api base path: ${value}`);
    });

    it('file source', async () => {
        const h = await start((b) => b.setOpenApi(FIXTURE));
        const doc = (await request(h.cli.app).get('/qcli/api/openapi.json')).body;
        expect(doc.info.title).toBe('RateBell API');
        expect(doc.security).toEqual([{ qcliToken: [] }]);
    });

    it('unreadable file', async () => {
        const missing = path.join(__dirname, 'fixtures', 'nope.json');
        await expect(start((b) => b.setOpenApi(missing))).rejects.toThrow(`public-api: cannot read OpenAPI document ${missing}`);
        const invalid = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-openapi-')), 'invalid.json');
        fs.writeFileSync(invalid, '{ not json');
        await expect(start((b) => b.setOpenApi(invalid))).rejects.toThrow(`public-api: cannot read OpenAPI document ${invalid}`);
    });

    it('x-codeSamples pass through', async () => {
        const h = await start();
        const doc = (await request(h.cli.app).get('/qcli/api/openapi.json')).body;
        expect(doc.paths['/v1/rates'].get['x-codeSamples']).toEqual([
            { lang: 'curl', label: 'cURL', source: 'curl https://api.example.com/v1/rates' },
        ]);
    });

    it('the document is not mutated between requests', async () => {
        const source = fixture();
        const h = await start((b) => b.setOpenApi(source));
        const one = (await request(h.cli.app).get('/qcli/api/openapi.json').set('Host', 'one.example.com')).body;
        const two = (await request(h.cli.app).get('/qcli/api/openapi.json').set('Host', 'two.example.com')).body;
        expect(one.servers).toEqual([{ url: 'http://one.example.com' }]);
        expect(two.servers).toEqual([{ url: 'http://two.example.com' }]);
        expect(source).not.toHaveProperty('servers');
        expect(source).not.toHaveProperty('security');
        expect(source).not.toHaveProperty('components');
    });

    it('without a document: an empty one with the additions', async () => {
        const h = await start(() => undefined);
        const doc = (await request(h.cli.app).get('/qcli/api/openapi.json')).body;
        expect(doc).toMatchObject({ openapi: '3.1.0', info: { title: 'API', version: '1.0.0' }, paths: {}, security: [{ qcliToken: [] }] });
    });

    it('public on a protected server, even under /api', async () => {
        const h = await start((b) => b.setOpenApi(fixture()).setBasePath('/api/public'));
        expect(h.users.protectServer).toBe(true);
        expect((await request(h.cli.app).get('/api/public/openapi.json')).status).toBe(200);
        expect((await request(h.cli.app).get('/api/public/openapi.json').set(auth('garbage'))).status).toBe(200);
        expect((await request(h.cli.app).get('/api/public/swagger')).status).toBe(200);
        expect((await request(h.cli.app).get('/api/public/swagger/assets/swagger-ui-bundle.js')).status).toBe(200);
    });
});
