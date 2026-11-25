/**
 * The portal plugin's `portal` config provider and `portal` command: the builder's branding as defaults, stored
 * values overriding them live in /portal.json, validation errors, the read-only site section; the command's text
 * (site found or missing, with and without sections), --json, and config:read on a protected server.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'path';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliDocsBuilder } from '@qodalis/cli-server-plugin-docs';
import { CliPortalBuilder, PORTAL_SITE_NOT_FOUND, type PortalPluginResult } from '@qodalis/cli-server-plugin-portal';
import { InMemoryConfigStore } from '@qodalis/cli-server-abstractions';
import { protect, runCommand } from './command-test-helpers';

const SITE = path.join(__dirname, 'fixtures', 'portal-site');
const DOCS = path.join(__dirname, 'fixtures', 'docs');
const HINT = 'Change the branding with config set portal.branding.<key> <value> (name, logoUrl, themeMode, footerLinks).';

const disposables: Array<() => void> = [];
afterEach(() => {
    vi.restoreAllMocks();
    while (disposables.length) disposables.pop()!();
});

interface Options {
    sections?: boolean;
    siteDir?: string;
    configure?: (b: CliPortalBuilder) => void;
}

/** A server with the portal (stand-in site), optionally the docs (3 pages) and public-api sections. */
function start({ sections = true, siteDir = SITE, configure }: Options = {}): { cli: CliServerResult; portal: PortalPluginResult } {
    const cli = createCliServer();
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    const builder = new CliPortalBuilder().setSiteDir(siteDir).setName('RateBell API').addFooterLink({ label: 'Terms', url: '/terms' });
    configure?.(builder);
    if (sections) {
        const docs = new CliDocsBuilder().addFolder(DOCS).build();
        cli.mountPlugin(docs);
        // the public-api plugin's section (the plugin itself needs the users plugin; portal.json only reads its section)
        builder.addSection(docs).addSection({ portalSection: { kind: 'api', title: 'API reference', basePath: '/qcli/api' } });
    }
    const portal = builder.build();
    cli.mountPlugin(portal);
    return { cli, portal };
}

const portalJson = async (cli: CliServerResult) => (await request(cli.app).get('/qcli/portal/portal.json').expect(200)).body;
// The config service (the admin plugin serves it as GET/PATCH /api/v1/qcli/config), as an open server's caller
const context = { hasPermission: () => true, via: 'api' as const };
const getSection = async (cli: CliServerResult, section: string) =>
    (await cli.builder.config.get('portal', context)).sections.find((s) => s.id === section) as any;
const entry = (section: any, key: string) => section.entries.find((e: any) => e.key === key);
async function patch(cli: CliServerResult, changes: Record<string, unknown>, sectionId = 'branding'): Promise<{ status: number; body: any }> {
    try {
        return { status: 200, body: await cli.builder.config.update('portal', sectionId, { changes: changes as any }, context) };
    } catch (err) {
        const e = err as { status?: number; message: string; errors?: Record<string, string> };
        if (e.status === undefined) throw err;
        return { status: e.status, body: { error: e.message, errors: e.errors } };
    }
}
const ok = async (cli: CliServerResult, changes: Record<string, unknown>) => {
    const res = await patch(cli, changes);
    expect(res.body.errors).toBeUndefined();
    expect(res.status).toBe(200);
    return res;
};

describe('portal config provider', () => {
    it('branding: the builder values are the defaults', async () => {
        const { cli } = start({ configure: (b) => b.setLogoUrl('/logo.svg').setTheme({ mode: 'dark' }) });
        const branding = await getSection(cli, 'branding');
        expect(branding.entries.map((e: any) => [e.key, e.type, e.value, e.default, e.source, e.mutable])).toEqual([
            ['name', 'string', 'RateBell API', 'RateBell API', 'default', true],
            ['logoUrl', 'string', '/logo.svg', '/logo.svg', 'default', true],
            ['themeMode', 'enum', 'dark', 'dark', 'default', true],
            ['footerLinks', 'json', [{ label: 'Terms', url: '/terms' }], [{ label: 'Terms', url: '/terms' }], 'default', true],
        ]);
        expect(entry(branding, 'themeMode').validation).toEqual({ options: ['system', 'light', 'dark'] });
        expect(branding.version).toBe('0');
    });

    it('branding: unset builder values default to Documentation, no logo, system, no links', async () => {
        const cli = createCliServer();
        disposables.push(() => {
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        cli.mountPlugin(new CliPortalBuilder().setSiteDir(SITE).build());
        const branding = await getSection(cli, 'branding');
        expect(branding.entries.map((e: any) => e.value)).toEqual(['Documentation', null, 'system', []]);
    });

    it('site: path, siteFound and sections, read-only', async () => {
        const { cli } = start();
        const site = await getSection(cli, 'site');
        expect(site.entries.map((e: any) => [e.key, e.value, e.mutable])).toEqual([
            ['path', '/qcli/portal', false],
            ['siteFound', true, false],
            ['sections', ['docs', 'api'], false],
        ]);
        expect(site.version).toBeNull();
        expect(await patch(cli, { path: '/x' }, 'site')).toEqual({ status: 400, body: { error: 'config section portal.site is read-only', errors: undefined } });
    });

    it('stored values override the defaults and apply live to /portal.json, no restart', async () => {
        const { cli } = start({ configure: (b) => b.setTheme({ mode: 'system', light: { primary: '#0a7' } }) });
        expect((await portalJson(cli)).name).toBe('RateBell API');
        const res = await patch(cli, {
            name: 'Acme Docs',
            logoUrl: 'https://cdn.example.com/logo.png',
            themeMode: 'dark',
            footerLinks: [
                { label: 'Privacy', url: 'https://example.com/privacy' },
                { label: 'Status', url: '/status' },
            ],
        });
        expect(res.body).toMatchObject({ applied: ['name', 'logoUrl', 'themeMode', 'footerLinks'], requiresRestart: false });
        const json = await portalJson(cli);
        expect(json).toMatchObject({
            name: 'Acme Docs',
            logo: 'https://cdn.example.com/logo.png',
            theme: { mode: 'dark', dark: {}, light: { primary: '#0a7' } },
            footerLinks: [
                { label: 'Privacy', url: 'https://example.com/privacy' },
                { label: 'Status', url: '/status' },
            ],
        });
        expect(json.docs).toEqual({ title: 'Guides', pages: '/qcli/docs/pages' });
        const branding = await getSection(cli, 'branding');
        expect(entry(branding, 'name')).toMatchObject({ value: 'Acme Docs', default: 'RateBell API', source: 'runtime' });
    });

    it('values already in the config store override the defaults from startup', async () => {
        const store = new InMemoryConfigStore();
        await store.write('portal', 'branding', { name: 'Stored Name', themeMode: 'light', footerLinks: [{ label: 'Blog', url: '/blog' }] });
        const cli = createCliServer({ configure: (b) => b.setConfigStore(store) });
        disposables.push(() => {
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        cli.mountPlugin(new CliPortalBuilder().setSiteDir(SITE).setName('RateBell API').build());
        await cli.builder.config.ready();
        expect(await portalJson(cli)).toMatchObject({ name: 'Stored Name', theme: { mode: 'light' }, footerLinks: [{ label: 'Blog', url: '/blog' }] });
        expect(entry(await getSection(cli, 'branding'), 'name')).toMatchObject({ value: 'Stored Name', default: 'RateBell API' });
    });

    it("logoUrl '' removes the logo; a reset (null) brings the builder's value back", async () => {
        const { cli } = start({ configure: (b) => b.setLogoUrl('/logo.svg') });
        await ok(cli, { logoUrl: '' });
        expect((await portalJson(cli)).logo).toBeNull();
        await ok(cli, { logoUrl: 'data:image/png;base64,iVBORw0KGgo=' });
        expect((await portalJson(cli)).logo).toBe('data:image/png;base64,iVBORw0KGgo=');
        await ok(cli, { logoUrl: null, name: 'Other', footerLinks: [] });
        expect((await portalJson(cli)).footerLinks).toEqual([]);
        await ok(cli, { name: null, footerLinks: null });
        const json = await portalJson(cli);
        expect(json).toMatchObject({ name: 'RateBell API', logo: '/logo.svg', footerLinks: [{ label: 'Terms', url: '/terms' }] });
    });

    it('config set portal.branding.<key> changes the site live', async () => {
        const { cli } = start();
        expect((await runCommand(cli, 'config set portal.branding.name "Acme Docs"')).text).toBe('Updated portal.branding.name = Acme Docs (version 1)');
        expect((await runCommand(cli, 'config set portal.branding.themeMode light')).text).toBe('Updated portal.branding.themeMode = light (version 2)');
        expect((await runCommand(cli, `config set portal.branding.footerLinks '[{"label":"Blog","url":"https://example.com/blog"}]'`)).text).toMatch(
            /^Updated portal\.branding\.footerLinks = /,
        );
        expect(await portalJson(cli)).toMatchObject({
            name: 'Acme Docs',
            theme: { mode: 'light' },
            footerLinks: [{ label: 'Blog', url: 'https://example.com/blog' }],
        });
    });

    it('validation: per-key errors, nothing applied', async () => {
        const { cli } = start();
        const tooMany = Array.from({ length: 21 }, (_, i) => ({ label: `L${i}`, url: '/x' }));
        const errors = async (changes: Record<string, unknown>) => {
            const res = await patch(cli, changes);
            expect(res.status).toBe(400);
            return res.body.errors;
        };
        expect(await errors({ name: '' })).toEqual({ name: 'must be at least 1 characters' });
        expect(await errors({ name: 'x'.repeat(81) })).toEqual({ name: 'must be at most 80 characters' });
        expect(await errors({ name: 'a\nb' })).toEqual({ name: 'portal name must be 1-80 characters without control characters' });
        expect(await errors({ logoUrl: 'javascript:alert(1)' })).toEqual({ logoUrl: 'portal logo must be an http(s) URL, a root-relative path or a data:image URL' });
        expect(await errors({ logoUrl: '//evil.example/logo.png' })).toEqual({ logoUrl: 'portal logo must be an http(s) URL, a root-relative path or a data:image URL' });
        expect(await errors({ themeMode: 'blue' })).toEqual({ themeMode: 'must be one of: system, light, dark' });
        expect(await errors({ footerLinks: { label: 'x', url: '/x' } })).toEqual({ footerLinks: 'must be a list of { "label": ..., "url": ... } links' });
        expect(await errors({ footerLinks: ['x'] })).toEqual({ footerLinks: 'must be a list of { "label": ..., "url": ... } links' });
        expect(await errors({ footerLinks: tooMany })).toEqual({ footerLinks: 'must have at most 20 links' });
        expect(await errors({ footerLinks: [{ label: 'Bad', url: 'ftp://x' }] })).toEqual({ footerLinks: 'invalid portal footer link: Bad' });
        expect(await errors({ footerLinks: [{ label: '', url: '/x' }] })).toEqual({ footerLinks: 'invalid portal footer link: ' });
        expect((await runCommand(cli, 'config set portal.branding.themeMode blue')).text).toBe('Error: validation failed\n  themeMode: must be one of: system, light, dark');
        expect((await portalJson(cli)).name).toBe('RateBell API');
    });
});

describe('portal command', () => {
    it('is registered under the portal module with status, needing config:read', () => {
        const { cli } = start();
        const processor = cli.registry.findProcessor('portal')!;
        expect(processor.requiredPermissions).toEqual(['config:read']);
        expect(processor.processors!.map((p) => p.command)).toEqual(['status']);
        expect(processor.module).toBe('portal');
        expect((cli.registry as { moduleOf(p: unknown): string | undefined }).moduleOf(processor)).toBe('portal');
        expect(processor.description).toContain('config set portal.branding.<key>');
    });

    it('portal and portal status: path, site, sections with the page count and the API, branding', async () => {
        const { cli } = start({ configure: (b) => b.setLogoUrl('/logo.svg') });
        const expected = [
            'Portal: /qcli/portal',
            `Site: found, setSiteDir (${SITE})`,
            'Sections:',
            '  docs  Guides, 3 pages (/qcli/docs/pages)',
            '  api   API reference (/qcli/api/openapi.json)',
            'Branding:',
            '  name         RateBell API',
            '  logoUrl      /logo.svg',
            '  themeMode    system',
            '  footerLinks  Terms (/terms)',
            '',
            HINT,
        ].join('\n');
        expect((await runCommand(cli, 'portal')).text).toBe(expected);
        expect((await runCommand(cli, 'portal status')).text).toBe(expected);
    });

    it('shows the current branding after config set', async () => {
        const { cli } = start();
        await runCommand(cli, 'config set portal.branding.name Acme');
        await runCommand(cli, 'config set portal.branding.logoUrl data:image/png;base64,iVBORw0KGgo=');
        const text = (await runCommand(cli, 'portal')).text;
        expect(text).toContain('  name         Acme\n');
        expect(text).toContain('  logoUrl      data:image/png;base64,… (34 characters)\n');
    });

    it('without sections or footer links', async () => {
        const cli = createCliServer();
        disposables.push(() => {
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        cli.mountPlugin(new CliPortalBuilder().setSiteDir(SITE).setPath('/help').build());
        expect((await runCommand(cli, 'portal')).text).toBe(
            [
                'Portal: /help',
                `Site: found, setSiteDir (${SITE})`,
                'Sections: none (the site shows "Nothing published yet")',
                'Branding:',
                '  name         Documentation',
                '  logoUrl      (none)',
                '  themeMode    system',
                '  footerLinks  (none)',
                '',
                HINT,
            ].join('\n'),
        );
    });

    it('site missing: says the portal is not served, the provider shows siteFound false', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { cli } = start({ siteDir: path.join(__dirname, 'fixtures', 'no-such-site') });
        expect(warn).toHaveBeenCalledWith(PORTAL_SITE_NOT_FOUND);
        const text = (await runCommand(cli, 'portal')).text;
        expect(text.split('\n').slice(0, 2)).toEqual([
            'Portal: /qcli/portal',
            'Site: not found, the portal is not served (install @qodalis/cli-server-portal or call setSiteDir)',
        ]);
        expect(text).toContain('  docs  Guides, 3 pages (/qcli/docs/pages)');
        expect(entry(await getSection(cli, 'site'), 'siteFound').value).toBe(false);
        const json = JSON.parse((await runCommand(cli, 'portal --json')).text);
        expect(json.site).toEqual({ path: '/qcli/portal', found: false, source: null, dir: null });
    });

    it('--json: portal.json with the page count, and the site', async () => {
        const { cli } = start();
        await runCommand(cli, 'config set portal.branding.themeMode dark');
        const json = JSON.parse((await runCommand(cli, 'portal --json')).text);
        expect(json).toEqual({
            name: 'RateBell API',
            logo: null,
            theme: { mode: 'dark', dark: {}, light: {} },
            footerLinks: [{ label: 'Terms', url: '/terms' }],
            docs: { title: 'Guides', pages: '/qcli/docs/pages', pageCount: 3 },
            api: { title: 'API reference', openapi: '/qcli/api/openapi.json', swagger: '/qcli/api/swagger' },
            site: { path: '/qcli/portal', found: true, source: 'siteDir', dir: SITE },
        });
        expect(JSON.parse((await runCommand(cli, 'portal status --json')).text)).toEqual(json);
        // the same as /portal.json, but for pageCount and site
        const { site: _site, ...rest } = json;
        const { pageCount: _count, ...docs } = json.docs;
        expect(await portalJson(cli)).toEqual({ ...rest, docs });
    });

    it('on a protected server: config:read runs it, commands:execute alone is refused, the portal stays public', async () => {
        const { cli } = start();
        const { plugin, tokens } = await protect(cli, { runner: ['commands:execute'], reader: ['commands:execute', 'config:read'] });
        disposables.push(() => plugin.dispose());
        expect((await runCommand(cli, 'portal')).status).toBe(401);
        expect((await runCommand(cli, 'portal', tokens.runner)).status).toBe(403);
        const ok = await runCommand(cli, 'portal status', tokens.reader);
        expect(ok.status).toBe(200);
        expect(ok.text.split('\n')[0]).toBe('Portal: /qcli/portal');
        expect((await runCommand(cli, 'portal', tokens.root)).text).toContain('  name         RateBell API');
        // changing the branding needs config:write
        expect((await runCommand(cli, 'config set portal.branding.name Nope', tokens.reader)).status).toBe(403);
        expect((await runCommand(cli, 'config set portal.branding.name Acme', tokens.root)).text).toBe('Updated portal.branding.name = Acme (version 1)');
        expect((await request(cli.app).get('/qcli/portal/portal.json').expect(200)).body.name).toBe('Acme');
    });
});
