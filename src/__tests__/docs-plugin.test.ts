/**
 * The docs plugin: markdown pages from a folder or code, front matter and variables,
 * served as JSON at `<base>/pages`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder } from '../../plugins/users/index';
import { CliDocsBuilder, DocsPluginResult, parsePage } from '@qodalis/cli-server-plugin-docs';
import { ROOT_PASS, auth } from './users-test-helpers';

const FIXTURE = path.join(__dirname, 'fixtures', 'docs');

const disposables: Array<() => void> = [];

afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

function start(configure: (b: CliDocsBuilder) => void = () => undefined, fixture = true): { cli: CliServerResult; docs: DocsPluginResult } {
    const builder = new CliDocsBuilder().setName('RateBell API').setVariable('support', 'help@ratebell.app');
    if (fixture) builder.addFolder(FIXTURE);
    configure(builder);
    const docs = builder.build();
    const cli = createCliServer();
    cli.mountPlugin(docs);
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return { cli, docs };
}

/** A folder with the given files. */
function folder(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-docs-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
}

describe('docs plugin', () => {
    it('pages list in order', async () => {
        const { cli } = start();
        const res = await request(cli.app).get('/qcli/docs/pages').set('Host', 'localhost');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.text).toBe(
            '[{"slug":"limits","title":"Limits and quotas","group":"Guides","order":0},' +
                '{"slug":"index","title":"Welcome to RateBell API","group":"Guides","order":1},' +
                '{"slug":"auth","title":"Authentication","group":"Basics","order":2}]',
        );
    });

    it('page replaces variables', async () => {
        const { cli } = start();
        const res = await request(cli.app).get('/qcli/docs/pages/index').set('Host', 'localhost');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(res.body).toEqual({
            slug: 'index',
            title: 'Welcome to RateBell API',
            group: 'Guides',
            order: 1,
            markdown: 'Call http://localhost/v1/rates with help@ratebell.app and {{unknown}}.\n',
        });
        expect(Object.keys(res.body)).toEqual(['slug', 'title', 'group', 'order', 'markdown']);
    });

    it('page: front matter removed, heading kept', async () => {
        const { cli } = start();
        const res = await request(cli.app).get('/qcli/docs/pages/auth');
        expect(res.body.markdown).toBe('# Ignored heading\nSend `Authorization: Bearer <token>`.\n');
        expect(res.body.title).toBe('Authentication');
        expect(res.body.group).toBe('Basics');
    });

    it('baseUrl option', async () => {
        const { cli } = start((b) => b.setBaseUrl('https://api.ratebell.app'));
        const res = await request(cli.app).get('/qcli/docs/pages/index');
        expect(res.body.markdown.startsWith('Call https://api.ratebell.app/v1/rates')).toBe(true);
    });

    it.each(['nope', 'INDEX', '..%2Fsecret', 'index.md', '..%2F..%2Fpackage.json'])('unknown slug %s: 404', async (slug) => {
        const { cli } = start();
        const res = await request(cli.app).get(`/qcli/docs/pages/${slug}`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'page not found' });
    });

    it('code pages', async () => {
        const { cli, docs } = start((b) => b.addPage('errors', '# Errors\nBody'));
        const res = await request(cli.app).get('/qcli/docs/pages');
        expect(res.body[0]).toEqual({ slug: 'errors', title: 'Errors', group: 'Guides', order: 0 });
        expect(docs.pages.map((p) => p.slug)).toEqual(['errors', 'limits', 'index', 'auth']);
        const page = await request(cli.app).get('/qcli/docs/pages/errors');
        expect(page.body.markdown).toBe('# Errors\nBody');
    });

    it.each<[string, (b: CliDocsBuilder) => void, string]>([
        ['bad slug', (b) => b.addPage('Bad Slug', '# x'), 'invalid docs page slug: Bad Slug'],
        ['bad file name', (b) => b.addFolder(folder({ 'Read Me.md': '# x' })), 'invalid docs page name: Read Me.md'],
        ['duplicate', (b) => b.addFolder(FIXTURE).addPage('index', '# again'), 'duplicate docs page: index'],
        ['missing folder', (b) => b.addFolder('/no/such/docs-folder'), 'docs folder not found: /no/such/docs-folder'],
        ['bad order', (b) => b.addPage('bad', '---\norder: x\n---\nbody'), 'invalid order in docs page: bad'],
        ['built-in baseUrl', (b) => b.setVariable('baseUrl', 'x'), 'docs variable is built in: baseUrl'],
        ['built-in name', (b) => b.setVariable('name', 'x'), 'docs variable is built in: name'],
        ['bad variable', (b) => b.setVariable('1x', 'y'), 'invalid docs variable: 1x'],
        ['root base path', (b) => b.setBasePath('/'), 'invalid docs base path: /'],
        ['relative base path', (b) => b.setBasePath('docs'), 'invalid docs base path: docs'],
        ['trailing slash', (b) => b.setBasePath('/docs/'), 'invalid docs base path: /docs/'],
    ])('startup error: %s', (_name, configure, message) => {
        const builder = new CliDocsBuilder();
        configure(builder);
        expect(() => builder.build()).toThrow(message);
    });

    it('a folder skips dot and underscore files, subfolders and other files', async () => {
        const dir = folder({ '.hidden.md': '# h', '_draft.md': '# d', 'notes.txt': 'x', 'Guide.md': '# Guide' });
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.writeFileSync(path.join(dir, 'sub', 'deep.md'), '# deep');
        const docs = new CliDocsBuilder().addFolder(dir).build();
        expect(docs.pages.map((p) => p.slug)).toEqual(['guide']);
    });

    it('front matter unclosed is body', () => {
        const page = parsePage('open', '---\ntitle: x\nbody');
        expect(page.title).toBe('open');
        expect(page.markdown).toBe('---\ntitle: x\nbody');
        expect(page.group).toBe('Guides');
        expect(page.order).toBe(0);
    });

    it('parse: quotes and unknown keys', () => {
        const page = parsePage('quoted', "---\ntitle: 'A: B'\nauthor: x\ngroup: \"Basics\"\norder: -3\n---\n# Heading\nbody\n");
        expect(page).toEqual({ slug: 'quoted', title: 'A: B', group: 'Basics', order: -3, markdown: '# Heading\nbody\n' });
    });

    it('ignores credentials', async () => {
        const users = new CliUsersBuilder().setOptions({ defaultAdminPassword: ROOT_PASS }).build();
        await users.ready;
        const { cli } = start();
        cli.mountPlugin(users);
        disposables.push(() => users.dispose());
        for (const bearer of ['garbage', 'qcli_pat_unknown']) {
            expect((await request(cli.app).get('/qcli/docs/pages').set(auth(bearer))).status).toBe(200);
            expect((await request(cli.app).get('/qcli/docs/pages/auth').set(auth(bearer))).status).toBe(200);
        }
    });

    it('public on a protected server, even under /api', async () => {
        const users = new CliUsersBuilder().setOptions({ defaultAdminPassword: ROOT_PASS }).build();
        await users.ready;
        const { cli } = start((b) => b.setBasePath('/api/docs'));
        cli.mountPlugin(users);
        disposables.push(() => users.dispose());
        expect((await request(cli.app).get('/api/docs/pages')).status).toBe(200);
        expect((await request(cli.app).get('/api/docs/pages/index')).status).toBe(200);
    });

    it('portal section registered', () => {
        const { docs } = start();
        expect(docs.portalSection).toEqual({ kind: 'docs', title: 'Guides', basePath: '/qcli/docs' });
        expect(docs.cliRoutes).toBe(false);
        expect(docs.prefix).toBe('/qcli/docs');
        const titled = new CliDocsBuilder().setTitle('Handbook').setBasePath('/developers/docs').build();
        expect(titled.portalSection).toEqual({ kind: 'docs', title: 'Handbook', basePath: '/developers/docs' });
    });
});
