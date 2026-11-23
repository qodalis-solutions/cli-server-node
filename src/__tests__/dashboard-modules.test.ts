/**
 * Dashboard modules: the pages plugins serve themselves (`dashboardModulePage`, a mounted plugin's
 * `dashboardPages`), served at `/qcli/modules/<id>` without a token, and registered as dashboard extensions
 * with the contract's fields (widgets, search) by the plugins that own their APIs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    CliDashboardExtension,
    DataExplorerLanguage,
    DataExplorerOutputFormat,
    dashboardModulePage,
    validateDashboardExtension,
} from '@qodalis/cli-server-abstractions';
import { InMemoryFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliAuditBuilder } from '../../plugins/audit/index';
import { CliUsersBuilder } from '../../plugins/users/index';
import { CliAdminBuilder } from '../../plugins/admin';

const V1 = '/api/v1/qcli';

const disposables: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
});

/** A fake module build: `extension.js` (and `extension.css`). */
function build(js = 'export default {};', css: string | null = '.x{}'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-module-'));
    fs.writeFileSync(path.join(dir, 'extension.js'), js);
    if (css !== null) fs.writeFileSync(path.join(dir, 'extension.css'), css);
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'logo.svg'), '<svg/>');
    disposables.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function dispose(cli: CliServerResult) {
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
}

const TITLES = (extension: CliDashboardExtension) => Object.keys(extension.titles ?? {}).sort();
const LANGUAGES = ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ro', 'ru', 'zh'];

describe('dashboardModulePage', () => {
    it('hashes the entry and styles and serves the files with no-cache, falling through for anything else', async () => {
        const dir = build();
        const page = dashboardModulePage(dir, { id: 'jobs', title: 'Jobs' });
        expect(page.prefix).toBe('/qcli/modules/jobs');
        expect(page.extension.entry).toMatch(/^\/qcli\/modules\/jobs\/extension\.js\?v=[0-9a-f]{12}$/);
        expect(page.extension.styles).toEqual([expect.stringMatching(/^\/qcli\/modules\/jobs\/extension\.css\?v=[0-9a-f]{12}$/)]);
        // Another build, another hash
        expect(dashboardModulePage(build('export default { mount() {} };'), { id: 'jobs', title: 'Jobs' }).extension.entry).not.toBe(page.extension.entry);
        expect(dashboardModulePage(build(undefined, null), { id: 'x', title: 'X' }).extension.styles).toBeUndefined();

        const app = express();
        app.use(page.prefix, page.handler);
        app.use((_req, res) => void res.status(404).send('fallthrough'));

        const js = await request(app).get('/qcli/modules/jobs/extension.js?v=abc');
        expect(js.status).toBe(200);
        expect(js.text).toBe('export default {};');
        expect(js.headers['content-type']).toMatch(/^text\/javascript/);
        expect(js.headers['cache-control']).toBe('no-cache');
        expect((await request(app).get('/qcli/modules/jobs/extension.css')).headers['content-type']).toMatch(/^text\/css/);
        expect((await request(app).get('/qcli/modules/jobs/assets/logo.svg')).headers['content-type']).toBe('image/svg+xml');
        const again = await request(app).get('/qcli/modules/jobs/extension.js').set('If-None-Match', js.headers.etag);
        expect(again.status).toBe(304);
        expect((await request(app).head('/qcli/modules/jobs/extension.js')).status).toBe(200);

        expect((await request(app).get('/qcli/modules/jobs/missing.js')).text).toBe('fallthrough');
        expect((await request(app).get('/qcli/modules/jobs/')).text).toBe('fallthrough');
        expect((await request(app).get('/qcli/modules/jobs/assets')).text).toBe('fallthrough');
        expect((await request(app).get('/qcli/modules/jobs/..%2f..%2fetc%2fpasswd')).text).toBe('fallthrough');
        expect((await request(app).post('/qcli/modules/jobs/extension.js')).text).toBe('fallthrough');
    });

    it('validates and keeps widgets and search', () => {
        const base = { id: 'jobs', title: 'Jobs', entry: '/x.js' };
        expect(validateDashboardExtension({ ...base, widgets: ['overview', 'palette', 'overview'], search: '/?q=' })).toEqual({
            ...base,
            widgets: ['overview', 'palette'],
            search: '/?q=',
        });
        expect(validateDashboardExtension({ ...base, widgets: [] })).toEqual(base);
        expect(() => validateDashboardExtension({ ...base, widgets: ['Over view'] })).toThrow('widgets must be');
        expect(() => validateDashboardExtension({ ...base, widgets: 'overview' as never })).toThrow('widgets must be');
        expect(() => validateDashboardExtension({ ...base, search: '?q=' })).toThrow('search must be');
        expect(() => validateDashboardExtension({ ...base, search: '//evil' })).toThrow('search must be');
        expect(() => validateDashboardExtension({ ...base, search: '/? q=' })).toThrow('search must be');
    });
});

describe('dashboard pages of the plugins', () => {
    it('jobs: Jobs page with overview and palette widgets and search, or none', () => {
        const [page] = new CliJobsBuilder().setDashboardDir(build()).build().dashboardPages;
        expect(page.prefix).toBe('/qcli/modules/jobs');
        expect(page.extension).toMatchObject({
            id: 'jobs',
            title: 'Jobs',
            icon: '⏱',
            group: 'operations',
            order: 10,
            permission: 'jobs:read',
            widgets: ['overview', 'palette'],
            search: '/?q=',
        });
        expect(page.extension.titles?.ro).toBe('Joburi');
        expect(TITLES(page.extension)).toEqual(LANGUAGES);
        expect(new CliJobsBuilder().setDashboardDir(false).build().dashboardPages).toEqual([]);
    });

    it('audit: Audit page with search, or none', () => {
        const [page] = new CliAuditBuilder().setDashboardDir(build()).build().dashboardPages;
        expect(page.prefix).toBe('/qcli/modules/audit');
        expect(page.extension).toMatchObject({ id: 'audit', title: 'Audit', icon: '🛡', group: 'operations', order: 30, permission: 'audit:read', search: '/?q=' });
        expect(page.extension.widgets).toBeUndefined();
        expect(TITLES(page.extension)).toEqual(LANGUAGES);
        expect(new CliAuditBuilder().setDashboardDir(false).build().dashboardPages).toEqual([]);
    });

    it("users: API tokens page and the Audit page of the audit plugin it serves; none in guard-only mode", () => {
        const audit = new CliAuditBuilder().setDashboardDir(build()).build();
        const users = new CliUsersBuilder().setDashboardDir(build()).setAuditPlugin(audit).build(() => {});
        disposables.push(() => users.dispose());
        expect(users.dashboardPages.map((p) => p.extension.id)).toEqual(['tokens', 'audit']);
        const tokens = users.dashboardPages[0].extension;
        expect(tokens).toMatchObject({ id: 'tokens', title: 'API tokens', icon: '🔑', group: 'access', order: 10 });
        expect(tokens.permission).toBeUndefined();
        expect(tokens.titles?.ro).toBe('Tokenuri API');
        expect(TITLES(tokens)).toEqual(LANGUAGES);

        const none = new CliUsersBuilder().setDashboardDir(false).setAuditPlugin(new CliAuditBuilder().setDashboardDir(false).build()).build(() => {});
        disposables.push(() => none.dispose());
        expect(none.dashboardPages).toEqual([]);
        const guard = new CliUsersBuilder().setGuardOnly(true).setDashboardDir(build()).setAuditPlugin(audit).build(() => {});
        disposables.push(() => guard.dispose());
        expect(guard.dashboardPages).toEqual([]);
    });

    it('core: Filesystem and Data explorer pages with their APIs, or none', async () => {
        const provider = {
            executeAsync: async () => ({ success: true, source: 'db', language: DataExplorerLanguage.Sql, defaultOutputFormat: DataExplorerOutputFormat.Table, columns: [], rows: [], rowCount: 0, truncated: false, executionTime: 0 }),
        };
        const cli = createCliServer({
            configure: (b) => {
                b.setFileStorageProvider(new InMemoryFileStorageProvider());
                b.addDataExplorerProvider(provider as never, { name: 'db', description: 'Db', language: DataExplorerLanguage.Sql, defaultOutputFormat: DataExplorerOutputFormat.Table });
                b.setDashboardModuleDir('filesystem', build('export const fs = 1;'));
                b.setDashboardModuleDir('data-explorer', build('export const de = 1;'));
            },
        });
        dispose(cli);
        const byId = Object.fromEntries(cli.builder.dashboardExtensions.map((e) => [e.id, e]));
        expect(byId.filesystem).toMatchObject({ title: 'Filesystem', icon: '📁', group: 'data', order: 10, permission: 'files:read' });
        expect(byId['data-explorer']).toMatchObject({ title: 'Data explorer', icon: '⛁', group: 'data', order: 15, permission: 'data:query' });
        expect(TITLES(byId.filesystem)).toEqual(LANGUAGES);
        expect(TITLES(byId['data-explorer'])).toEqual(LANGUAGES);
        expect((await request(cli.app).get('/qcli/modules/filesystem/extension.js')).text).toBe('export const fs = 1;');
        expect((await request(cli.app).get('/qcli/modules/data-explorer/extension.js')).text).toBe('export const de = 1;');

        const without = createCliServer({
            configure: (b) => {
                b.setFileStorageProvider(new InMemoryFileStorageProvider());
                b.setDashboardModuleDir('filesystem', false);
            },
        });
        dispose(without);
        expect(without.builder.dashboardExtensions.map((e) => e.id)).not.toContain('filesystem');
        // No filesystem API, no page
        const bare = createCliServer({ configure: (b) => void b.setDashboardModuleDir('filesystem', build()) });
        dispose(bare);
        expect(bare.builder.dashboardExtensions).toEqual([]);
    });

    it('a mounted plugin serves its pages to anyone on a protected server; the extensions list carries widgets and search', async () => {
        const cli = createCliServer();
        const users = new CliUsersBuilder()
            .setOptions({ defaultAdminPassword: 'root-pass-123', protectServer: true })
            .setDashboardDir(false)
            .setAuditPlugin(new CliAuditBuilder().setDashboardDir(false).build())
            .build(cli.eventBus);
        await users.ready;
        cli.mountPlugin(users);
        const jobs = new CliJobsBuilder().setDashboardDir(build('export default { jobs: true };')).build();
        cli.mountPlugin(jobs);
        const admin = new CliAdminBuilder().setAuthProvider(users.serverAuth).build({
            registry: cli.registry,
            eventSocketManager: cli.eventSocketManager,
            builder: cli.builder,
            broadcastFn: () => {},
        });
        cli.mountPlugin(admin);
        disposables.push(() => {
            admin.dispose();
            users.dispose();
            jobs.scheduler.stop();
        });
        dispose(cli);

        const js = await request(cli.app).get('/qcli/modules/jobs/extension.js');
        expect(js.status).toBe(200);
        expect(js.text).toBe('export default { jobs: true };');
        expect(js.headers['cache-control']).toBe('no-cache');
        expect((await request(cli.app).get(`${V1}/jobs`)).status).toBe(401);
        expect((await request(cli.app).get(`${V1}/dashboard/extensions`)).status).toBe(401);

        const login = await request(cli.app).post(`${V1}/sessions`).send({ username: 'root', password: 'root-pass-123' });
        const res = await request(cli.app).get(`${V1}/dashboard/extensions`).set('Authorization', `Bearer ${login.body.token}`);
        expect(res.status).toBe(200);
        expect(res.body.extensions).toEqual([
            expect.objectContaining({ id: 'jobs', widgets: ['overview', 'palette'], search: '/?q=', entry: expect.stringMatching(/^\/qcli\/modules\/jobs\/extension\.js\?v=/) }),
        ]);
    });
});
