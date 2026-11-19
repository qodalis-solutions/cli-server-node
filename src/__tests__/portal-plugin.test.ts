/**
 * The portal plugin: the prebuilt portal site at one mount (only its own fixed paths) and
 * `portal.json` with the docs and API sections. Uses a small stand-in site.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { spawnSync } from 'child_process';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { CliDocsBuilder, DocsPluginResult } from '@qodalis/cli-server-plugin-docs';
import { CliPublicApiBuilder, PublicApiPluginResult } from '@qodalis/cli-server-plugin-public-api';
import { CliPortalBuilder, isSafePathPrefix, resolvePortalSiteDir } from '@qodalis/cli-server-plugin-portal';
import { ROOT_PASS } from './users-test-helpers';

const SITE = path.join(__dirname, 'fixtures', 'portal-site');
const DOCS = path.join(__dirname, 'fixtures', 'docs');

interface Harness {
    cli: CliServerResult;
    users: UsersPluginResult;
    docs: DocsPluginResult;
    api: PublicApiPluginResult;
}

const disposables: Array<() => void> = [];

afterEach(() => {
    vi.restoreAllMocks();
    while (disposables.length) disposables.pop()!();
});

async function start(): Promise<Harness> {
    const cli = createCliServer();
    const users = new CliUsersBuilder().setOptions({ defaultAdminPassword: ROOT_PASS }).build();
    await users.ready;
    cli.mountPlugin(users);
    const docs = new CliDocsBuilder().addFolder(DOCS).build();
    const api = new CliPublicApiBuilder().setUsers(users).setOpenApi({ openapi: '3.1.0', info: { title: 'Stub', version: '1' }, paths: {} }).build();
    cli.mountPlugin(docs);
    cli.mountPlugin(api);
    disposables.push(() => {
        users.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return { cli, users, docs, api };
}

const portal = () =>
    new CliPortalBuilder()
        .setSiteDir(SITE)
        .setName('RateBell API')
        .addFooterLink({ label: 'Terms', url: '/terms' })
        .setTheme({ light: { primary: '#0a7' } });

describe('portal plugin', () => {
    it('portal.json: both sections', async () => {
        const h = await start();
        h.cli.mountPlugin(portal().addSection(h.docs).addSection(h.api).build());
        const res = await request(h.cli.app).get('/qcli/portal/portal.json');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(res.text).toBe(
            '{"name":"RateBell API","logo":null,"theme":{"mode":"system","dark":{},"light":{"primary":"#0a7"}},' +
                '"footerLinks":[{"label":"Terms","url":"/terms"}],' +
                '"docs":{"title":"Guides","pages":"/qcli/docs/pages"},' +
                '"api":{"title":"API reference","openapi":"/qcli/api/openapi.json","swagger":"/qcli/api/swagger"}}',
        );
    });

    it('portal.json: docs only', async () => {
        const h = await start();
        h.cli.mountPlugin(portal().addSection(h.docs).build());
        const body = (await request(h.cli.app).get('/qcli/portal/portal.json')).body;
        expect(body.docs).toEqual({ title: 'Guides', pages: '/qcli/docs/pages' });
        expect(body.api).toBeNull();
    });

    it('portal.json: api only', async () => {
        const h = await start();
        h.cli.mountPlugin(portal().addSection(h.api).build());
        const body = (await request(h.cli.app).get('/qcli/portal/portal.json')).body;
        expect(body.docs).toBeNull();
        expect(body.api).toEqual({ title: 'API reference', openapi: '/qcli/api/openapi.json', swagger: '/qcli/api/swagger' });
    });

    it('portal.json: no sections, defaults', async () => {
        const h = await start();
        h.cli.mountPlugin(new CliPortalBuilder().setSiteDir(SITE).build());
        expect((await request(h.cli.app).get('/qcli/portal/portal.json')).body).toEqual({
            name: 'Documentation',
            logo: null,
            theme: { mode: 'system', dark: {}, light: {} },
            footerLinks: [],
            docs: null,
            api: null,
        });
    });

    it.each(['/qcli/portal', '/qcli/portal/', '/qcli/portal/guides/auth', '/qcli/portal/reference', '/qcli/portal/reference/Rates'])(
        'index for site route %s',
        async (p) => {
            const h = await start();
            h.cli.mountPlugin(portal().addSection(h.docs).build());
            const res = await request(h.cli.app).get(p);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
            expect(res.headers['cache-control']).toBe('no-cache');
            expect(res.text).toContain('<base href="/qcli/portal/" />');
            expect(res.text).not.toContain('<base href="/" />');
            const head = await request(h.cli.app).head(p);
            expect(head.status).toBe(200);
            expect(head.text ?? '').toBe('');
        },
    );

    it('assets served', async () => {
        const h = await start();
        h.cli.mountPlugin(portal().build());
        const app = await request(h.cli.app).get('/qcli/portal/assets/app.js');
        expect(app.status).toBe(200);
        expect(app.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        expect(app.text).toContain('portal');
        const icon = await request(h.cli.app).get('/qcli/portal/favicon.svg');
        expect(icon.status).toBe(200);
        expect(icon.headers['content-type']).toMatch(/^image\/svg\+xml/);
    });

    it.each<[string, string]>([
        ['GET', '/qcli/portal/other'],
        ['GET', '/qcli/portal/assets/missing.js'],
        ['GET', '/qcli/portal/assets/..%2Findex.html'],
        ['GET', '/qcli/portal/guides/a/b'],
        ['GET', '/qcli/portal/index.html'],
        ['GET', '/qcli/portal/Reference'],
        ['POST', '/qcli/portal/'],
        ['DELETE', '/qcli/portal/portal.json'],
    ])('other paths fall through: %s %s', async (method, p) => {
        const h = await start();
        h.cli.mountPlugin(portal().build());
        const agent = request(h.cli.app);
        const res = method === 'GET' ? await agent.get(p) : method === 'POST' ? await agent.post(p) : await agent.delete(p);
        expect(res.status).toBe(404);
        expect(res.text).not.toContain('<base href');
    });

    it.each(['before', 'after'])('root mount does not shadow host routes (host routes registered %s)', async (when) => {
        const h = await start();
        const hostRoutes = () => {
            h.cli.app.get('/v1/rates', (_req, res) => res.type('text').send('rates'));
            h.cli.app.get('/health', (_req, res) => res.json({ ok: true }));
        };
        if (when === 'before') hostRoutes();
        const root = portal().setPath('/').addSection(h.docs).addSection(h.api).build();
        expect(root.prefix).toBe('/');
        h.cli.mountPlugin(root);
        if (when === 'after') hostRoutes();

        for (const accept of ['*/*', 'text/html']) {
            const rates = await request(h.cli.app).get('/v1/rates').set('Accept', accept);
            expect(rates.status).toBe(200);
            expect(rates.text).toBe('rates');
            const health = await request(h.cli.app).get('/health').set('Accept', accept);
            expect(health.body).toEqual({ ok: true });
        }
        for (const p of ['/', '/guides/x', '/reference', '/reference/Rates']) {
            const res = await request(h.cli.app).get(p);
            expect(res.status, p).toBe(200);
            expect(res.text).toContain('<base href="/" />');
        }
        expect((await request(h.cli.app).get('/portal.json')).status).toBe(200);
        expect((await request(h.cli.app).get('/assets/app.js')).status).toBe(200);
        // the other plugins' routes still answer
        expect((await request(h.cli.app).get('/qcli/docs/pages')).status).toBe(200);
        expect((await request(h.cli.app).get('/qcli/api/openapi.json')).status).toBe(200);
        expect((await request(h.cli.app).get('/api/qcli/versions')).status).toBe(200);
        expect((await request(h.cli.app).get('/nothing-here')).status).toBe(404);
    });

    it.each([
        ['/qcli/portal', '/proxy/qcli/portal/'],
        ['/', '/proxy/'],
    ])('under a path prefix (mount %s): portal.json URLs and <base href> include it', async (mount, href) => {
        const h = await start();
        h.cli.mountPlugin(portal().setPath(mount).addSection(h.docs).addSection(h.api).build());
        const outer = express();
        outer.use('/proxy', h.cli.app);
        const at = mount === '/' ? '/proxy' : `/proxy${mount}`;
        const json = (await request(outer).get(`${at}/portal.json`)).body;
        expect(json.docs).toEqual({ title: 'Guides', pages: '/proxy/qcli/docs/pages' });
        expect(json.api).toEqual({ title: 'API reference', openapi: '/proxy/qcli/api/openapi.json', swagger: '/proxy/qcli/api/swagger' });
        const page = await request(outer).get(`${at}/guides/auth`);
        expect(page.text).toContain(`<base href="${href}" />`);
        // without a prefix nothing changes
        expect((await request(h.cli.app).get(mount === '/' ? '/portal.json' : `${mount}/portal.json`)).body.docs.pages).toBe('/qcli/docs/pages');
    });

    it('a path base starting with // or /\\ answers 400 invalid path base', async () => {
        for (const ok of ['', '/proxy', '/a/b']) expect(isSafePathPrefix(ok), ok).toBe(true);
        for (const bad of ['//evil.example.com', '/\\evil.example.com']) expect(isSafePathPrefix(bad), bad).toBe(false);
        const h = await start();
        h.cli.mountPlugin(portal().setPath('/').build());
        // what a parent app mounted at a protocol-relative path hands the portal
        const outer = express();
        outer.use((req, res, next) => {
            Object.defineProperty(req, 'baseUrl', { get: () => '//evil.example.com', set: () => undefined, configurable: true });
            h.cli.app(req, res, next);
        });
        for (const p of ['/portal.json', '/', '/guides/x']) {
            const res = await request(outer).get(p);
            expect(res.status, p).toBe(400);
            expect(res.body).toEqual({ error: 'invalid path base' });
        }
    });

    it('no site serves nothing', async () => {
        const h = await start();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-portal-'));
        h.cli.mountPlugin(portal().setSiteDir(empty).addSection(h.docs).build());
        expect((await request(h.cli.app).get('/qcli/portal/')).status).toBe(404);
        expect((await request(h.cli.app).get('/qcli/portal/portal.json')).status).toBe(404);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[qcli] portal site not found; the portal is not served');
    });

    it.each<[string, (b: CliPortalBuilder) => void, string]>([
        ['long name', (b) => b.setName('x'.repeat(81)), 'portal name must be 1-80 characters without control characters'],
        ['empty name', (b) => b.setName(''), 'portal name must be 1-80 characters without control characters'],
        ['control characters', (b) => b.setName('a\nb'), 'portal name must be 1-80 characters without control characters'],
        ['logo', (b) => b.setLogoUrl('javascript:alert(1)'), 'portal logo must be an http(s) URL, a root-relative path or a data:image URL'],
        ['protocol-relative logo', (b) => b.setLogoUrl('//evil.example.com/x.png'), 'portal logo must be an http(s) URL, a root-relative path or a data:image URL'],
        ['colour', (b) => b.setTheme({ light: { primary: 'red;}' } }), 'invalid portal colour light.primary: red;}'],
        ['unknown token', (b) => b.setTheme({ dark: { nope: '#fff' } as never }), 'invalid portal colour dark.nope: #fff'],
        [
            '21 footer links',
            (b) => {
                for (let i = 1; i <= 21; i++) b.addFooterLink({ label: `Link ${i}`, url: '/x' });
            },
            'invalid portal footer link: Link 21',
        ],
        ['link url', (b) => b.addFooterLink({ label: 'Files', url: 'ftp://x' }), 'invalid portal footer link: Files'],
        ['empty label', (b) => b.addFooterLink({ label: '', url: '/x' }), 'invalid portal footer link: '],
        ['path', (b) => b.setPath('qcli'), 'invalid portal path: qcli'],
        ['trailing slash', (b) => b.setPath('/docs/'), 'invalid portal path: /docs/'],
    ])('invalid options throw: %s', (_name, configure, message) => {
        const builder = new CliPortalBuilder().setSiteDir(SITE);
        configure(builder);
        expect(() => builder.build()).toThrow(message);
    });

    it('valid options', async () => {
        const h = await start();
        const built = new CliPortalBuilder()
            .setSiteDir(SITE)
            .setPath('/developers')
            .setLogoUrl('data:image/png;base64,iVBORw0KGgo=')
            .setTheme({ mode: 'dark', dark: { background: 'oklch(0.2 0.01 250)', text: 'white' } })
            .addFooterLink({ label: 'Status', url: 'https://status.example.com' })
            .build();
        h.cli.mountPlugin(built);
        const body = (await request(h.cli.app).get('/developers/portal.json')).body;
        expect(body.logo).toBe('data:image/png;base64,iVBORw0KGgo=');
        expect(body.theme).toEqual({ mode: 'dark', dark: { background: 'oklch(0.2 0.01 250)', text: 'white' }, light: {} });
        expect((await request(h.cli.app).get('/developers/guides/x')).text).toContain('<base href="/developers/" />');
    });

    it('duplicate section throws', async () => {
        const h = await start();
        const other = new CliDocsBuilder().setBasePath('/more/docs').build();
        expect(() => new CliPortalBuilder().setSiteDir(SITE).addSection(h.docs).addSection(other).build()).toThrow(
            'portal section already registered: docs',
        );
    });

    it('the plugin result', async () => {
        const built = portal().build();
        expect(built.prefix).toBe('/qcli/portal');
        expect(built.cliRoutes).toBe(false);
        expect(built.installedPlugin.id).toBe('@qodalis/cli-server-plugin-portal');
    });

    it.each(['before', 'after'])(
        'public prefixes never open a host route under them (host routes registered %s mounting)',
        async (when) => {
            const h = await start();
            const reached: string[] = [];
            const hostRoutes = () => {
                for (const p of ['/api/developers/reference/x/y', '/api/developers/assets/secret/file', '/api/developers/guides/a/b', '/api/developers/assets/secret']) {
                    h.cli.app.get(p, (_req, res) => {
                        reached.push(p);
                        res.json({ secret: true });
                    });
                }
            };
            if (when === 'before') hostRoutes();
            h.cli.mountPlugin(portal().setPath('/api/developers').build());
            if (when === 'after') hostRoutes();
            for (const p of ['/api/developers/reference/x/y', '/api/developers/assets/secret/file', '/api/developers/guides/a/b', '/api/developers/assets/secret']) {
                const res = await request(h.cli.app).get(p);
                expect(res.status, p).toBe(404);
                expect(res.body, p).toEqual({ error: 'not found' });
            }
            expect(reached).toEqual([]);
            // with a token the gate lets the request on, and still only the portal answers under its prefixes
            expect((await request(h.cli.app).get('/api/v1/qcli/commands')).status).toBe(401);
        },
    );

    it.each(['/api', '/api/v1', '/api/v1/qcli/docs', '/ws', '/API'])('a portal mount holding or inside CLI routes is refused: %s', (mount) => {
        expect(() => new CliPortalBuilder().setSiteDir(SITE).setPath(mount).build()).toThrow(`invalid portal path: ${mount}`);
    });

        it('resolves the site: explicit alone, else the npm package, the sibling repo (checkouts only), the bundled copy', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-portal-resolve-'));
        const repo = path.join(root, 'cli-server-node');
        const pkg = path.join(repo, 'plugins', 'portal');
        const site = (dir: string) => {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'index.html'), '<base href="/" />');
            return dir;
        };
        fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
        const noNpm = () => null;
        expect(resolvePortalSiteDir(undefined, path.join(pkg, 'dist'), noNpm)).toBeNull();

        const bundled = site(path.join(pkg, 'site'));
        expect(resolvePortalSiteDir(undefined, path.join(pkg, 'dist'), noNpm)).toBe(bundled);

        // a sibling next to an installed package (no checkout) is never used
        const sibling = site(path.join(root, 'cli-server-dashboard', 'portal', 'dist'));
        expect(resolvePortalSiteDir(undefined, path.join(pkg, 'dist'), noNpm)).toBe(bundled);
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@qodalis/cli-server-node' }));
        fs.mkdirSync(path.join(repo, '.git'));
        expect(resolvePortalSiteDir(undefined, path.join(pkg, 'dist'), noNpm)).toBe(sibling);

        const npm = site(path.join(root, 'node_modules', '@qodalis', 'cli-server-portal', 'dist'));
        expect(resolvePortalSiteDir(undefined, path.join(pkg, 'dist'), () => npm)).toBe(npm);

        expect(resolvePortalSiteDir(SITE, path.join(pkg, 'dist'), () => npm)).toBe(SITE);
        // an explicit folder without a site is not replaced by another one
        expect(resolvePortalSiteDir(root, path.join(pkg, 'dist'), () => npm)).toBeNull();
    });

    it.each([
        ['--publish', 1],
        ['', 0],
    ])('copy-portal.js without a site source: %s exits %d', (flag, code) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-copy-portal-'));
        const scripts = path.join(root, 'a', 'cli-server-node', 'plugins', 'portal', 'scripts');
        fs.mkdirSync(scripts, { recursive: true });
        fs.copyFileSync(path.join(__dirname, '..', '..', 'plugins', 'portal', 'scripts', 'copy-portal.js'), path.join(scripts, 'copy-portal.js'));
        const result = spawnSync(process.execPath, [path.join(scripts, 'copy-portal.js'), ...(flag ? [flag] : [])], { cwd: root, encoding: 'utf8' });
        expect(result.status).toBe(code);
        expect(fs.existsSync(path.join(scripts, '..', 'site'))).toBe(false);
    });

    it('public on a protected server under /api: pages, assets, deep links; the CLI still needs a token', async () => {
        const h = await start();
        expect(h.users.protectServer).toBe(true);
        const docs = new CliDocsBuilder().setBasePath('/api/docs').addFolder(DOCS).build();
        h.cli.mountPlugin(docs);
        h.cli.mountPlugin(portal().setPath('/api/developers').addSection(docs).addSection(h.api).build());
        for (const p of [
            '/api/developers',
            '/api/developers/',
            '/api/developers/portal.json',
            '/api/developers/assets/app.js',
            '/api/developers/favicon.svg',
            '/api/developers/guides/auth',
            '/api/developers/reference',
            '/api/developers/reference/Rates',
            '/api/docs/pages',
            '/api/docs/pages/auth',
        ]) {
            const res = await request(h.cli.app).get(p);
            expect(res.status, p).toBe(200);
        }
        // an unknown asset falls through to the gate-free 404, never a sign-in
        expect((await request(h.cli.app).get('/api/developers/assets/missing.js')).status).toBe(404);
        expect((await request(h.cli.app).get('/api/v1/qcli/commands')).status).toBe(401);
        expect((await request(h.cli.app).get('/api/other')).status).toBe(401);
        // segment boundary: a longer name is not under the public prefix
        expect((await request(h.cli.app).get('/api/developersx/assets/app.js')).status).toBe(401);
        expect((await request(h.cli.app).get('/api/developers/assetsx/app.js')).status).toBe(401);
    });

});
