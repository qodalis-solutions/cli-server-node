/**
 * Dashboard plugins from the marketplace (admin plugin): browsing with annotations, the trust policy (verified, listed,
 * off), the dashboard API, downloads from jsDelivr then unpkg checked against the marketplace's sha384 (a mismatch
 * stores nothing), an unreachable marketplace, install / update / remove, live registration and serving at
 * /qcli/modules/<id>/, persistence across a restart, id clashes, path-traversal-safe names, permissions on a
 * protected server, audit and events, and the `admin dashboard` command. A fake marketplace and CDN: no network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createCliServer } from '../create-cli-server';
import {
    CliAdminBuilder,
    compareDashboardPluginVersions,
    dashboardPluginDirName,
    dashboardPluginId,
    isValidDashboardPluginName,
    nodeServerPackage,
    sha384Integrity,
    type MarketplaceFetch,
} from '../../plugins/admin/index';
import { runCommand, V1 } from './command-test-helpers';
import {
    API,
    BASE,
    FakeNet,
    FakePluginOptions,
    Host,
    JOBS,
    MARKET,
    TICKETS,
    JSDELIVR,
    UNPKG,
    auth,
    cleanupMarketplaceHosts,
    integrityOf,
    response,
    start,
    startProtected,
    trackHost,
} from './dashboard-marketplace-test-helpers';

afterEach(cleanupMarketplaceHosts);


describe('dashboard marketplace: helpers', () => {
    it('derives the page id: official modules by their suffix, else the extension id, else the package name', () => {
        expect(dashboardPluginId('@qodalis/cli-dashboard-module-jobs')).toBe('jobs');
        expect(dashboardPluginId('@qodalis/cli-dashboard-module-data-explorer', 'other')).toBe('data-explorer');
        expect(dashboardPluginId('@acme/cli-dashboard-tickets', 'helpdesk')).toBe('helpdesk');
        expect(dashboardPluginId('@acme/cli-dashboard-tickets', 'Bad Id')).toBe('tickets');
        expect(dashboardPluginId('@acme/cli-dashboard-plugin-crm')).toBe('crm');
        expect(dashboardPluginId('my.page_v2')).toBe('my-page-v2');
        expect(dashboardPluginId('___')).toBeUndefined();
    });

    it('keeps names inside the storage directory: scoped names become @scope+name, traversal is refused', () => {
        expect(dashboardPluginDirName('@acme/tickets')).toBe('@acme+tickets');
        expect(dashboardPluginDirName('tickets')).toBe('tickets');
        for (const bad of ['../etc', '..', '.hidden', '@acme/../../x', 'a/b', '@acme/x/y', 'UPPER', 'a\\b', '', 'x'.repeat(215), '@/x', 'a\0b']) {
            expect(isValidDashboardPluginName(bad)).toBe(false);
            expect(() => dashboardPluginDirName(bad)).toThrow('invalid package name');
        }
    });

    it('compares versions as semver, prereleases before their release', () => {
        const sorted = ['1.0.0', '1.0.0-beta.10', '1.0.0-beta.2', '0.9.9', '1.0.0-alpha', '1.10.0', '1.2.0'].sort(compareDashboardPluginVersions);
        expect(sorted).toEqual(['0.9.9', '1.0.0-alpha', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0', '1.2.0', '1.10.0']);
    });

    it('reads the Node server package from either form of serverPackages; sha384 as SRI', () => {
        expect(nodeServerPackage({ node: '@qodalis/cli-server-plugin-jobs', dotnet: 'Qodalis.Cli.Plugin.Jobs' })).toBe('@qodalis/cli-server-plugin-jobs');
        expect(nodeServerPackage([{ ecosystem: 'nuget', name: 'X' }, { ecosystem: 'npm', name: 'y', install: 'npm i y' }])).toBe('y');
        expect(nodeServerPackage(undefined)).toBeUndefined();
        expect(nodeServerPackage({ dotnet: 'X' })).toBeUndefined();
        expect(sha384Integrity(Buffer.from('abc'))).toBe(integrityOf('abc'));
    });
});

describe('dashboard marketplace: browsing', () => {
    it('GET / reports the marketplace, the install policy and the dashboard API', async () => {
        const h = await start();
        const res = await request(h.cli.app).get(BASE).set(auth(h.token));
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual({ marketplaceUrl: MARKET, install: 'verified', dashboardApi: 1 });
        expect((await request(h.cli.app).get(BASE)).status).toBe(401);
    });

    it('GET /plugins proxies kind=dashboard and annotates each item', async () => {
        const net = new FakeNet();
        net.publish(JOBS, { icon: '⏱️', title: 'Jobs', serverPackages: [{ ecosystem: 'npm', name: '@qodalis/cli-server-plugin-jobs', install: 'npm install @qodalis/cli-server-plugin-jobs' }, { ecosystem: 'pypi', name: 'qodalis-cli-server-plugin-jobs', install: 'pip install qodalis-cli-server-plugin-jobs' }], versions: [{ version: '1.0.0' }, { version: '1.1.0' }] });
        net.publish(TICKETS, { verified: false, versions: [{ version: '2.0.0' }] });
        net.publish('@acme/cli-dashboard-next', { versions: [{ version: '3.0.0', dashboardApi: 2 }] });
        net.publish('@acme/web-thing', { kind: 'web', versions: [{ version: '1.0.0' }] });
        const h = await start({ net });
        const res = await request(h.cli.app).get(`${BASE}/plugins?query=&page=1&pageSize=10`).set(auth(h.token));
        expect(res.status).toBe(200);
        const listUrl = net.calls.find((c) => c.startsWith(`${API}/plugins?`))!;
        expect(new URL(listUrl).searchParams.get('kind')).toBe('dashboard');
        expect(new URL(listUrl).searchParams.get('dashboardApi')).toBe('1');
        expect(new URL(listUrl).searchParams.get('pageSize')).toBe('10');
        expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 10 });
        const byName = Object.fromEntries(res.body.items.map((i: { name: string }) => [i.name, i]));
        expect(Object.keys(byName).sort()).toEqual(['@acme/cli-dashboard-next', TICKETS, JOBS].sort());
        expect(byName[JOBS]).toMatchObject({
            name: JOBS,
            kind: 'dashboard',
            publisher: { verified: true },
            installed: null,
            updateAvailable: false,
            allowed: true,
            requires: { serverPackage: '@qodalis/cli-server-plugin-jobs', installed: false },
        });
        expect(byName[JOBS].blockedReason).toBeUndefined();
        expect(byName[TICKETS]).toMatchObject({ allowed: false, blockedReason: 'unverified publisher', requires: null });
        expect(byName['@acme/cli-dashboard-next']).toMatchObject({ allowed: false, blockedReason: 'needs dashboard API 2' });
    });

    it('a marketplace that ignores the kind filter: only its dashboard plugins, counted on their own', async () => {
        const net = new FakeNet();
        net.ignoresKind = true;
        net.publish(JOBS, { versions: [{ version: '1.0.0' }] });
        for (const name of ['@acme/web-one', '@acme/web-two', '@acme/web-three']) net.publish(name, { kind: 'web', versions: [{ version: '1.0.0' }] });
        const h = await start({ net });

        const res = await request(h.cli.app).get(`${BASE}/plugins`).set(auth(h.token));
        expect(res.status).toBe(200);
        expect(res.body.items.map((i: { name: string }) => i.name)).toEqual([JOBS]);
        expect(res.body.total).toBe(1);

        // Only web plugins: an empty list with nothing counted (the live marketplace today)
        net.plugins.delete(JOBS);
        const none = await request(h.cli.app).get(`${BASE}/plugins`).set(auth(h.token));
        expect(none.body).toMatchObject({ items: [], total: 0 });
    });

    it('requires.installed follows the server plugins the server has (GET /plugins/installed)', async () => {
        const net = new FakeNet();
        net.publish(JOBS, { serverPackages: [{ ecosystem: 'npm', name: '@qodalis/cli-server-plugin-jobs', install: 'npm i @qodalis/cli-server-plugin-jobs' }], versions: [{ version: '1.0.0' }] });
        const h = await start({ net, configure: (cli) => cli.builder.addInstalledPlugin({ id: '@qodalis/cli-server-plugin-jobs', name: 'Jobs' }) });
        const res = await request(h.cli.app).get(`${BASE}/plugins`).set(auth(h.token));
        expect(res.body.items[0].requires).toEqual({ serverPackage: '@qodalis/cli-server-plugin-jobs', installed: true });
    });

    it('install listed allows unverified publishers; install off blocks everything', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { verified: false, versions: [{ version: '2.0.0' }] });
        const listed = await start({ net, install: 'listed' });
        expect((await request(listed.cli.app).get(`${BASE}/plugins`).set(auth(listed.token))).body.items[0]).toMatchObject({ allowed: true });
        const off = await start({ net, install: 'off' });
        expect((await request(off.cli.app).get(BASE).set(auth(off.token))).body.install).toBe('off');
        expect((await request(off.cli.app).get(`${BASE}/plugins`).set(auth(off.token))).body.items[0]).toMatchObject({ allowed: false, blockedReason: 'install disabled' });
    });

    it('GET /plugins/{name} returns details and versions, annotated; scoped names raw or encoded', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0' }, { version: '1.1.0', status: 'flagged' }, { version: '2.0.0', dashboardApi: 2 }] });
        const h = await start({ net });
        for (const path of [`${BASE}/plugins/${TICKETS}`, `${BASE}/plugins/${encodeURIComponent(TICKETS)}`]) {
            const res = await request(h.cli.app).get(path).set(auth(h.token));
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ name: TICKETS, installed: null, allowed: true, updateAvailable: false });
            const versions = Object.fromEntries(res.body.versions.map((v: { version: string }) => [v.version, v]));
            expect(versions['1.0.0']).toMatchObject({ allowed: true, files: [{ path: 'dist/extension.js' }, { path: 'dist/extension.css' }] });
            expect(versions['1.1.0']).toMatchObject({ allowed: false, blockedReason: 'version flagged' });
            expect(versions['2.0.0']).toMatchObject({ allowed: false, blockedReason: 'needs dashboard API 2' });
        }
        expect((await request(h.cli.app).get(`${BASE}/plugins/@acme/missing`).set(auth(h.token))).body).toEqual({ error: 'plugin not found: @acme/missing' });
        expect((await request(h.cli.app).get(`${BASE}/plugins/..%2F..%2Fetc`).set(auth(h.token))).status).toBe(400);
    });

    it('an unreachable marketplace is a 502 { error: marketplace unreachable }', async () => {
        const net = new FakeNet();
        net.marketplaceDown = true;
        const h = await start({ net });
        for (const res of [
            await request(h.cli.app).get(`${BASE}/plugins`).set(auth(h.token)),
            await request(h.cli.app).get(`${BASE}/plugins/${TICKETS}`).set(auth(h.token)),
            await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }),
        ]) {
            expect(res.status).toBe(502);
            expect(res.body).toEqual({ error: 'marketplace unreachable' });
        }
        expect(readdirSync(h.dir)).toEqual([]);
        // a marketplace answering 500 counts as unreachable too
        const broken = await start({
            net: Object.assign(new FakeNet(), { fetch: (async () => response(500, { error: 'boom' })) as MarketplaceFetch }),
        });
        expect((await request(broken.cli.app).get(`${BASE}/plugins`).set(auth(broken.token))).status).toBe(502);
    });

    it('rejects bad paging parameters', async () => {
        const h = await start();
        expect((await request(h.cli.app).get(`${BASE}/plugins?page=0`).set(auth(h.token))).body).toEqual({ error: 'invalid page' });
        expect((await request(h.cli.app).get(`${BASE}/plugins?pageSize=101`).set(auth(h.token))).body).toEqual({ error: 'invalid pageSize' });
    });
});

describe('dashboard marketplace: install, update, remove', () => {
    it('installs the newest fitting version: verified, stored, registered live and served from this server', async () => {
        const net = new FakeNet();
        net.publish(JOBS, { title: 'Jobs', icon: '⏱️', versions: [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '2.0.0', dashboardApi: 2 }, { version: '1.2.0', status: 'pending' }] });
        const h = await start({ net });
        const before = await request(h.cli.app).get(`${V1}/dashboard/extensions`).set(auth(h.token));
        expect(before.body.extensions.some((e: { id: string }) => e.id === 'jobs')).toBe(false);

        const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: JOBS });
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ name: JOBS, version: '1.1.0', title: 'Jobs', icon: '⏱️', id: 'jobs', installedAt: expect.any(String), installedBy: 'admin', hasConfig: false });

        // stored: <dir>/<safe-name>/<version>/{extension.js,extension.css} and installed.json, no staging leftovers
        const versionDir = join(h.dir, '@qodalis+cli-dashboard-module-jobs', '1.1.0');
        expect(readdirSync(versionDir).sort()).toEqual(['extension.css', 'extension.js']);
        expect(readdirSync(h.dir).sort()).toEqual(['@qodalis+cli-dashboard-module-jobs', 'installed.json']);
        const saved = JSON.parse(readFileSync(join(h.dir, 'installed.json'), 'utf8'));
        expect(saved).toEqual({
            plugins: [
                {
                    name: JOBS,
                    version: '1.1.0',
                    id: 'jobs',
                    title: 'Jobs',
                    icon: '⏱️',
                    files: [
                        { file: 'extension.js', path: 'dist/extension.js', integrity: expect.stringMatching(/^sha384-/), size: expect.any(Number) },
                        { file: 'extension.css', path: 'dist/extension.css', integrity: expect.stringMatching(/^sha384-/), size: expect.any(Number) },
                    ],
                    installedAt: res.body.installedAt,
                    installedBy: 'admin',
                },
            ],
        });
        // downloaded from jsDelivr (unpkg not needed)
        expect(net.calls.filter((c) => !c.startsWith(MARKET))).toEqual([
            `${JSDELIVR}/${JOBS}@1.1.0/dist/extension.js`,
            `${JSDELIVR}/${JOBS}@1.1.0/dist/extension.css`,
        ]);

        // live in the extensions list, marked as from the marketplace with its package (the dashboard needs no lookup)
        const after = await request(h.cli.app).get(`${V1}/dashboard/extensions`).set(auth(h.token));
        const page = after.body.extensions.find((e: { id: string }) => e.id === 'jobs');
        expect(page).toEqual({
            id: 'jobs',
            title: 'Jobs',
            icon: '⏱️',
            version: '1.1.0',
            entry: expect.stringMatching(/^\/qcli\/modules\/jobs\/extension\.js\?v=[0-9a-f]{12}$/),
            styles: [expect.stringMatching(/^\/qcli\/modules\/jobs\/extension\.css\?v=[0-9a-f]{12}$/)],
            source: 'marketplace',
            package: JOBS,
        });
        // a built-in page has neither
        expect(Object.keys(after.body.extensions.find((e: { id: string }) => e.id !== 'jobs') ?? {})).not.toContain('package');

        // served from this server's origin, no sign-in, with an ETag
        const js = await request(h.cli.app).get(page.entry);
        expect(js.status).toBe(200);
        expect(js.headers['content-type']).toMatch(/^text\/javascript/);
        expect(js.headers['cache-control']).toBe('no-cache');
        expect(js.text).toContain("version: '1.1.0'");
        expect((await request(h.cli.app).get('/qcli/modules/jobs/extension.js').set('If-None-Match', js.headers.etag)).status).toBe(304);
        expect((await request(h.cli.app).get(page.styles[0])).headers['content-type']).toMatch(/^text\/css/);
        expect((await request(h.cli.app).get('/qcli/modules/jobs/installed.json')).status).toBe(404);
        expect((await request(h.cli.app).get('/qcli/modules/jobs/..%2F..%2Finstalled.json')).status).toBe(404);
        expect((await request(h.cli.app).get('/qcli/modules/other/extension.js')).status).toBe(404);

        // audit and event
        expect(h.audit).toEqual([
            expect.objectContaining({
                event: 'dashboard.plugin.install',
                username: 'admin',
                actor: 'admin',
                target: JOBS,
                details: `${JOBS}@1.1.0`,
                properties: { name: JOBS, version: '1.1.0', id: 'jobs' },
            }),
        ]);
        expect(h.events.map((e) => ({ type: e.type, data: e.data, audience: e.audience }))).toEqual([
            { type: 'dashboard:extensions-changed', data: { action: 'install', name: JOBS, version: '1.1.0', id: 'jobs' }, audience: { permission: 'admin:access' } },
        ]);

        // GET /installed, the list item now annotated
        expect((await request(h.cli.app).get(`${BASE}/installed`).set(auth(h.token))).body).toEqual([{ ...res.body, updateAvailable: false }]);
        const listed = await request(h.cli.app).get(`${BASE}/plugins`).set(auth(h.token));
        expect(listed.body.items[0]).toMatchObject({ installed: { version: '1.1.0' } });
    });

    it('installs a given version; refuses unknown, unlisted, invalid and too-new versions', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0' }, { version: '1.1.0', status: 'flagged' }, { version: '2.0.0', dashboardApi: 2 }] });
        const h = await start({ net });
        const post = (body: object) => request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send(body);
        expect((await post({ name: TICKETS, version: '9.9.9' })).body).toEqual({ error: `version not found: ${TICKETS}@9.9.9` });
        expect((await post({ name: TICKETS, version: '1.1.0' })).status).toBe(404);
        expect((await post({ name: TICKETS, version: '2.0.0' })).body).toEqual({ error: 'needs dashboard API 2' });
        expect((await post({ name: TICKETS, version: '../1' })).body).toEqual({ error: 'invalid version' });
        expect((await post({})).body).toEqual({ error: 'invalid package name' });
        expect((await post({ name: '@acme/missing' })).body).toEqual({ error: 'plugin not found: @acme/missing' });
        const ok = await post({ name: TICKETS, version: '1.0.0' });
        expect(ok.status).toBe(201);
        expect(ok.body).toMatchObject({ version: '1.0.0', id: 'tickets', title: 'cli-dashboard-tickets', icon: null });
        expect((await post({ name: TICKETS })).body).toEqual({ error: `already installed: ${TICKETS}@1.0.0` });
    });

    it('refuses a plugin needing a newer dashboard API, a web plugin, and a version with bad file records', async () => {
        const net = new FakeNet();
        net.publish('@acme/cli-dashboard-next', { versions: [{ version: '3.0.0', dashboardApi: 2 }] });
        net.publish('@acme/web-thing', { kind: 'web', versions: [{ version: '1.0.0' }] });
        net.publish('@acme/cli-dashboard-bad', { versions: [{ version: '1.0.0' }] });
        ((net.plugins.get('@acme/cli-dashboard-bad')!.versions as Array<{ files: Array<{ path: string }> }>)[0].files[0].path = '../../evil.js');
        const h = await start({ net });
        const post = (name: string) => request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name });
        expect((await post('@acme/cli-dashboard-next')).body).toEqual({ error: 'needs dashboard API 2' });
        // The marketplace does not find a plugin of another kind; an older one that does is refused here
        expect((await post('@acme/web-thing')).body).toEqual({ error: 'plugin not found: @acme/web-thing' });
        net.ignoresKind = true;
        expect((await post('@acme/web-thing')).body).toEqual({ error: 'not a dashboard plugin: @acme/web-thing' });
        net.ignoresKind = false;
        const bad = await post('@acme/cli-dashboard-bad');
        expect(bad.status).toBe(502);
        expect(bad.body).toEqual({ error: 'invalid marketplace record: files' });
        expect(readdirSync(h.dir)).toEqual([]);
    });

    it('trust policy: verified (default) refuses unverified publishers with 403; listed allows them; off refuses all', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { verified: false, versions: [{ version: '1.0.0' }] });
        const verified = await start({ net });
        const refused = await request(verified.cli.app).post(`${BASE}/installed`).set(auth(verified.token)).send({ name: TICKETS });
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({ error: 'publisher not verified' });
        expect(readdirSync(verified.dir)).toEqual([]);
        expect(net.calls.some((c) => !c.startsWith(MARKET))).toBe(false);

        const listed = await start({ net, install: 'listed' });
        expect((await request(listed.cli.app).post(`${BASE}/installed`).set(auth(listed.token)).send({ name: TICKETS })).status).toBe(201);

        const off = await start({ net, install: 'off' });
        const disabled = await request(off.cli.app).post(`${BASE}/installed`).set(auth(off.token)).send({ name: TICKETS });
        expect(disabled.status).toBe(403);
        expect(disabled.body).toEqual({ error: 'install disabled' });
    });

    it('an integrity mismatch on every CDN is a 502 and stores nothing', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0', jsdelivr: 'tampered', unpkg: 'tampered too' }] });
        const h = await start({ net });
        const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS });
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'integrity mismatch: dist/extension.js' });
        expect(readdirSync(h.dir)).toEqual([]);
        expect(h.audit).toEqual([]);
        expect(h.events).toEqual([]);
        expect((await request(h.cli.app).get(`${V1}/dashboard/extensions`).set(auth(h.token))).body.extensions.some((e: { id: string }) => e.id === 'tickets')).toBe(false);
    });

    it('falls back to unpkg when jsDelivr fails or serves other bytes; both failing is download failed', async () => {
        const net = new FakeNet();
        net.publish('@acme/cli-dashboard-a', { versions: [{ version: '1.0.0', jsdelivr: null }] });
        net.publish('@acme/cli-dashboard-b', { versions: [{ version: '1.0.0', jsdelivr: 'tampered' }] });
        net.publish('@acme/cli-dashboard-c', { css: null, versions: [{ version: '1.0.0', css: null, jsdelivr: null, unpkg: null }] } as FakePluginOptions);
        const h = await start({ net });
        const post = (name: string) => request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name });
        expect((await post('@acme/cli-dashboard-a')).status).toBe(201);
        expect(net.calls).toContain(`${UNPKG}/@acme/cli-dashboard-a@1.0.0/dist/extension.js`);
        expect((await post('@acme/cli-dashboard-b')).status).toBe(201);
        expect(readFileSync(join(h.dir, '@acme+cli-dashboard-b', '1.0.0', 'extension.js'), 'utf8')).not.toBe('tampered');
        const failed = await post('@acme/cli-dashboard-c');
        expect(failed.status).toBe(502);
        expect(failed.body).toEqual({ error: 'download failed: dist/extension.js' });
        expect(existsSync(join(h.dir, '@acme+cli-dashboard-c'))).toBe(false);
    });

    it('refuses files over 5 MB', async () => {
        const net = new FakeNet();
        const big = 'x'.repeat(5 * 1024 * 1024 + 1);
        net.publish(TICKETS, { versions: [{ version: '1.0.0', js: big, css: null }] });
        const h = await start({ net });
        const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS });
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'file too large: dist/extension.js' });
    });

    it('reads the files from the version record when the details leave them out', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0', css: null }] });
        net.filesOnlyInVersionRecord = true;
        const h = await start({ net });
        expect((await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS })).status).toBe(201);
        expect(net.calls).toContain(`${API}/plugins/${encodeURIComponent(TICKETS)}/versions/1.0.0?kind=dashboard`);
        expect(readdirSync(join(h.dir, '@acme+cli-dashboard-tickets', '1.0.0'))).toEqual(['extension.js']);
    });

    it('an id taken by another extension is a 409', async () => {
        const net = new FakeNet();
        net.publish(JOBS, { versions: [{ version: '1.0.0' }] });
        net.publish('@acme/cli-dashboard-billing', { extensionId: 'billing', versions: [{ version: '1.0.0' }] });
        const h = await start({
            net,
            configure: (cli) => cli.builder.addDashboardExtension({ id: 'jobs', title: 'Jobs', entry: '/qcli/modules/jobs/extension.js' }),
        });
        const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: JOBS });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'dashboard extension already registered: jobs' });
        expect(readdirSync(h.dir)).toEqual([]);
        // the extension's own id; a second package with that id clashes with the first
        expect((await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: '@acme/cli-dashboard-billing' })).body.id).toBe('billing');
        net.publish('@other/billing-page', { extensionId: 'billing', versions: [{ version: '1.0.0' }] });
        expect((await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: '@other/billing-page' })).status).toBe(409);
    });

    it('path traversal in names is refused before anything is fetched or written', async () => {
        const h = await start();
        for (const name of ['../../etc/passwd', '..', '@acme/../x', 'a/b/c', '/abs', 'C:\\x']) {
            const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name });
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ error: 'invalid package name' });
        }
        expect((await request(h.cli.app).put(`${BASE}/installed/..%2F..%2Fetc`).set(auth(h.token)).send({})).status).toBe(400);
        expect((await request(h.cli.app).delete(`${BASE}/installed/..%2F..`).set(auth(h.token))).status).toBe(400);
        expect(h.net.calls).toEqual([]);
        expect(readdirSync(h.dir)).toEqual([]);
    });

    it('updates to the newest version: new files, same page id, old version deleted, audited and published', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0' }] });
        const h = await start({ net });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }).expect(201);
        const oldEntry = (await request(h.cli.app).get(`${V1}/dashboard/extensions`).set(auth(h.token))).body.extensions.find((e: { id: string }) => e.id === 'tickets').entry;

        // nothing newer: unchanged
        const same = await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({});
        expect(same.status).toBe(200);
        expect(same.body.version).toBe('1.0.0');
        expect(h.audit).toHaveLength(1);

        net.publish(TICKETS, { versions: [{ version: '1.0.0' }, { version: '1.2.0' }] });
        expect((await request(h.cli.app).get(`${BASE}/installed`).set(auth(h.token))).body[0].updateAvailable).toBe(true);
        expect((await request(h.cli.app).get(`${BASE}/plugins`).set(auth(h.token))).body.items[0]).toMatchObject({ installed: { version: '1.0.0' }, updateAvailable: true });

        const res = await request(h.cli.app).put(`${BASE}/installed/${encodeURIComponent(TICKETS)}`).set(auth(h.token)).send({});
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: TICKETS, version: '1.2.0', id: 'tickets' });
        expect(readdirSync(join(h.dir, '@acme+cli-dashboard-tickets'))).toEqual(['1.2.0']);
        const page = (await request(h.cli.app).get(`${V1}/dashboard/extensions`).set(auth(h.token))).body.extensions.filter((e: { id: string }) => e.id === 'tickets');
        expect(page).toHaveLength(1);
        expect(page[0].version).toBe('1.2.0');
        expect(page[0].entry).not.toBe(oldEntry);
        expect((await request(h.cli.app).get('/qcli/modules/tickets/extension.js')).text).toContain("version: '1.2.0'");
        expect(h.audit[1]).toMatchObject({ event: 'dashboard.plugin.update', details: `${TICKETS} 1.0.0 -> 1.2.0`, properties: { name: TICKETS, version: '1.2.0', id: 'tickets', previousVersion: '1.0.0' } });
        expect(h.events.map((e) => e.data.action)).toEqual(['install', 'update']);
        expect(h.events[1].data).toEqual({ action: 'update', name: TICKETS, version: '1.2.0', id: 'tickets', previousVersion: '1.0.0' });
        expect(JSON.parse(readFileSync(join(h.dir, 'installed.json'), 'utf8')).plugins.map((p: { version: string }) => p.version)).toEqual(['1.2.0']);

        // back to a given version
        expect((await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({ version: '1.0.0' })).body.version).toBe('1.0.0');
        // a failed update keeps the installed version
        net.publish(TICKETS, { versions: [{ version: '1.0.0' }, { version: '1.3.0', jsdelivr: 'bad', unpkg: 'bad' }] });
        expect((await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(h.token)).send({})).status).toBe(502);
        expect((await request(h.cli.app).get(`${BASE}/installed`).set(auth(h.token))).body[0].version).toBe('1.0.0');
        expect((await request(h.cli.app).get('/qcli/modules/tickets/extension.js')).status).toBe(200);
        expect((await request(h.cli.app).put(`${BASE}/installed/@acme/other`).set(auth(h.token)).send({})).body).toEqual({ error: 'not installed: @acme/other' });
    });

    it('removes a plugin: page unregistered, files deleted, audited and published', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0' }] });
        net.publish(JOBS, { versions: [{ version: '1.0.0' }] });
        const h = await start({ net });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }).expect(201);
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: JOBS }).expect(201);
        const res = await request(h.cli.app).delete(`${BASE}/installed/${TICKETS}`).set(auth(h.token));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: TICKETS, version: '1.0.0', id: 'tickets' });
        expect(existsSync(join(h.dir, '@acme+cli-dashboard-tickets'))).toBe(false);
        expect(existsSync(join(h.dir, '@qodalis+cli-dashboard-module-jobs', '1.0.0', 'extension.js'))).toBe(true);
        const ids = (await request(h.cli.app).get(`${V1}/dashboard/extensions`).set(auth(h.token))).body.extensions.map((e: { id: string }) => e.id);
        expect(ids).toContain('jobs');
        expect(ids).not.toContain('tickets');
        expect((await request(h.cli.app).get('/qcli/modules/tickets/extension.js')).status).toBe(404);
        expect(h.audit.map((a) => a.event)).toEqual(['dashboard.plugin.install', 'dashboard.plugin.install', 'dashboard.plugin.remove']);
        expect(h.events[2].data).toEqual({ action: 'remove', name: TICKETS, version: '1.0.0', id: 'tickets' });
        expect(JSON.parse(readFileSync(join(h.dir, 'installed.json'), 'utf8')).plugins.map((p: { name: string }) => p.name)).toEqual([JOBS]);
        expect((await request(h.cli.app).delete(`${BASE}/installed/${TICKETS}`).set(auth(h.token))).body).toEqual({ error: `not installed: ${TICKETS}` });
    });

    it('concurrent installs of one plugin: one wins, the other is a 409', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0' }] });
        const h = await start({ net });
        const [a, b] = await Promise.all([
            request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }),
            request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
    });
});

describe('dashboard marketplace: restart', () => {
    it('reloads installed plugins on start, offline, and serves them again', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { icon: '🎫', title: 'Tickets', versions: [{ version: '1.0.0' }] });
        const first = await start({ net });
        await request(first.cli.app).post(`${BASE}/installed`).set(auth(first.token)).send({ name: TICKETS }).expect(201);

        const offline = new FakeNet();
        offline.marketplaceDown = true;
        const second = await start({ net: offline, dir: first.dir });
        const page = (await request(second.cli.app).get(`${V1}/dashboard/extensions`).set(auth(second.token))).body.extensions.find((e: { id: string }) => e.id === 'tickets');
        expect(page).toMatchObject({ id: 'tickets', title: 'Tickets', icon: '🎫', version: '1.0.0', source: 'marketplace' });
        expect((await request(second.cli.app).get(page.entry)).status).toBe(200);
        // installed still listed; updateAvailable left out while the marketplace is unreachable
        const installed = await request(second.cli.app).get(`${BASE}/installed`).set(auth(second.token));
        expect(installed.body).toEqual([{ name: TICKETS, version: '1.0.0', title: 'Tickets', icon: '🎫', id: 'tickets', installedAt: expect.any(String), installedBy: 'admin', hasConfig: false }]);
        // and removable without the marketplace
        expect((await request(second.cli.app).delete(`${BASE}/installed/${TICKETS}`).set(auth(second.token))).status).toBe(200);
        expect(offline.calls.filter((c) => !c.startsWith(MARKET))).toEqual([]);
    });

    it('skips plugins whose files changed on disk or whose id is taken, and survives a broken installed.json', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0' }] });
        net.publish(JOBS, { versions: [{ version: '1.0.0' }] });
        const first = await start({ net });
        await request(first.cli.app).post(`${BASE}/installed`).set(auth(first.token)).send({ name: TICKETS }).expect(201);
        await request(first.cli.app).post(`${BASE}/installed`).set(auth(first.token)).send({ name: JOBS }).expect(201);
        writeFileSync(join(first.dir, '@acme+cli-dashboard-tickets', '1.0.0', 'extension.js'), 'alert("tampered")');

        const second = await start({
            net,
            dir: first.dir,
            configure: (cli) => cli.builder.addDashboardExtension({ id: 'jobs', title: 'Host jobs', entry: '/jobs.js' }),
        });
        const extensions = (await request(second.cli.app).get(`${V1}/dashboard/extensions`).set(auth(second.token))).body.extensions;
        expect(extensions.filter((e: { source?: string }) => e.source === 'marketplace')).toEqual([]);
        expect(extensions.find((e: { id: string }) => e.id === 'jobs').title).toBe('Host jobs');
        expect((await request(second.cli.app).get('/qcli/modules/tickets/extension.js')).status).toBe(404);

        writeFileSync(join(first.dir, 'installed.json'), '{ not json');
        const third = await start({ net, dir: first.dir });
        expect((await request(third.cli.app).get(`${BASE}/installed`).set(auth(third.token))).body).toEqual([]);
    });

    it('setMarketplace(false) serves no marketplace routes and loads nothing', async () => {
        const cli = createCliServer();
        const admin = new CliAdminBuilder()
            .setCredentials('admin', 'pass')
            .setJwtSecret('x')
            .setMarketplace(false)
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
        admin.logBuffer.restoreConsole();
        admin.statusSampler.stop();
        cli.mountPlugin(admin);
        trackHost({ cli, admin } as Host);
        expect(admin.marketplace).toBeUndefined();
        expect(admin.assetRoutes).toEqual([]);
        const token = (await request(cli.app).post(`${V1}/auth/login`).send({ username: 'admin', password: 'pass' })).body.token;
        expect((await request(cli.app).get(BASE).set(auth(token))).status).toBe(404);
        expect(cli.registry.findProcessor('admin')!.processors!.some((p) => p.command === 'dashboard')).toBe(false);
    });

    it('refuses an invalid marketplace url or policy when built', () => {
        const cli = createCliServer();
        const build = (options: object) => () =>
            new CliAdminBuilder().setCredentials('admin', 'pass').setMarketplace(options).build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
        expect(build({ url: 'ftp://x' })).toThrow('invalid marketplace url');
        expect(build({ install: 'everyone' })).toThrow('invalid marketplace install policy');
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
});

describe('dashboard marketplace: permissions on a protected server', () => {
    it('reading needs admin:access, changes need dashboard:install', async () => {
        const h = await startProtected({ viewer: ['admin:access'], installer: ['admin:access', 'dashboard:install'], outsider: ['files:read'] });
        h.net.publish(TICKETS, { versions: [{ version: '1.0.0' }] });
        const { tokens } = h;
        expect((await request(h.cli.app).get(BASE)).status).toBe(401);
        expect((await request(h.cli.app).get(BASE).set(auth(tokens.outsider))).status).toBe(403);
        expect((await request(h.cli.app).get(`${BASE}/plugins`).set(auth(tokens.viewer))).status).toBe(200);
        expect((await request(h.cli.app).get(`${BASE}/installed`).set(auth(tokens.viewer))).status).toBe(200);

        const denied = await request(h.cli.app).post(`${BASE}/installed`).set(auth(tokens.viewer)).send({ name: TICKETS });
        expect(denied.status).toBe(403);
        expect(denied.body.error).toContain('dashboard:install');
        expect((await request(h.cli.app).put(`${BASE}/installed/${TICKETS}`).set(auth(tokens.viewer)).send({})).status).toBe(403);
        expect((await request(h.cli.app).delete(`${BASE}/installed/${TICKETS}`).set(auth(tokens.viewer))).status).toBe(403);

        const ok = await request(h.cli.app).post(`${BASE}/installed`).set(auth(tokens.installer)).send({ name: TICKETS });
        expect(ok.status).toBe(201);
        expect(ok.body.installedBy).toBe('installer');
        expect((await request(h.cli.app).delete(`${BASE}/installed/${TICKETS}`).set(auth(tokens.root))).status).toBe(200);
        // the users plugin's audit log has both
        const audit = await request(h.cli.app).get(`${V1}/audit?event=dashboard.plugin.install`).set(auth(tokens.root));
        expect(JSON.stringify(audit.body)).toContain('installer');
        // dashboard:install is in the catalog
        const catalog = await request(h.cli.app).get(`${V1}/permissions`).set(auth(tokens.root));
        expect(catalog.body).toContainEqual({ name: 'dashboard:install', description: 'Install, update and remove dashboard plugins from the marketplace', group: 'Server', surface: 'cli' });
    });

    it('the files of installed plugins are served without sign-in', async () => {
        const h = await startProtected({});
        h.net.publish(TICKETS, { versions: [{ version: '1.0.0' }] });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.tokens.root)).send({ name: TICKETS }).expect(201);
        expect((await request(h.cli.app).get('/qcli/modules/tickets/extension.js')).status).toBe(200);
    });

    it('the command: install, update and remove need dashboard:install, list and search admin:access', async () => {
        const h = await startProtected({ viewer: ['admin:access', 'commands:execute'], installer: ['admin:access', 'commands:execute', 'dashboard:install'] });
        h.net.publish(TICKETS, { versions: [{ version: '1.0.0' }] });
        const dashboard = h.cli.registry.findProcessor('admin')!.processors!.find((p) => p.command === 'dashboard')!;
        expect(Object.fromEntries(dashboard.processors!.map((p) => [p.command, p.requiredPermissions]))).toEqual({
            list: undefined,
            search: undefined,
            install: ['dashboard:install'],
            update: ['dashboard:install'],
            remove: ['dashboard:install'],
        });
        expect((await runCommand(h.cli, 'admin dashboard search', h.tokens.viewer)).status).toBe(200);
        expect((await runCommand(h.cli, `admin dashboard install ${TICKETS}`, h.tokens.viewer)).status).toBe(403);
        const installed = await runCommand(h.cli, `admin dashboard install ${TICKETS}`, h.tokens.installer);
        expect(installed.text).toBe(`Installed ${TICKETS}@1.0.0: the dashboard page "cli-dashboard-tickets" (/x/tickets).`);
        expect((await request(h.cli.app).get(`${BASE}/installed`).set(auth(h.tokens.root))).body[0].installedBy).toBe('installer');
    });
});

describe('dashboard marketplace: admin dashboard command', () => {
    it('list, search, install name@version, update, remove', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { title: 'Tickets', serverPackages: [{ ecosystem: 'npm', name: '@acme/cli-server-plugin-tickets', install: 'npm install @acme/cli-server-plugin-tickets' }], versions: [{ version: '1.0.0' }, { version: '1.1.0' }] });
        net.publish('@other/cli-dashboard-crm', { verified: false, versions: [{ version: '0.1.0' }] });
        const h = await start({ net });
        const run = (line: string) => runCommand(h.cli, line).then((r) => r.text);

        expect(await run('admin dashboard')).toBe(`No dashboard plugins installed (marketplace ${MARKET}, install: verified; admin dashboard search <query> finds some).`);
        expect(await run('admin dashboard search')).toBe(
            [
                'Package                      Version  Publisher         Status',
                `${TICKETS}  1.1.0    @acme (verified)  installable; needs server plugin @acme/cli-server-plugin-tickets`,
                '@other/cli-dashboard-crm     0.1.0    @other            blocked: unverified publisher',
            ].join('\n'),
        );
        expect(await run('admin dashboard search nothing-like-this')).toBe('No dashboard plugins match "nothing-like-this".');

        expect(await run(`admin dashboard install ${TICKETS}@1.0.0`)).toBe(`Installed ${TICKETS}@1.0.0: the dashboard page "Tickets" (/x/tickets).`);
        expect(await run(`admin dashboard install ${TICKETS}`)).toBe(`Error: already installed: ${TICKETS}@1.0.0`);
        expect(await run('admin dashboard install @other/cli-dashboard-crm')).toBe('Error: publisher not verified');
        expect(await run('admin dashboard install ../../etc')).toBe('Error: invalid package name');
        expect(await run('admin dashboard install')).toBe('Error: name one package: admin dashboard install <name>[@version]');

        const list = await run('admin dashboard list');
        expect(list.split('\n')[0]).toBe(`1 dashboard plugin(s) from ${MARKET} (install: verified)`);
        expect(list.split('\n')[1]).toBe('ID       Package                      Version                   Installed            By');
        expect(list.split('\n')[2]).toMatch(new RegExp(`^tickets  ${TICKETS.replace(/\//g, "\\/")}  1\\.0\\.0 \\(update available\\)  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d  anonymous$`));
        expect(JSON.parse(await run('admin dashboard --json'))).toEqual([expect.objectContaining({ name: TICKETS, version: '1.0.0', updateAvailable: true })]);
        expect(await run('admin dashboard search tickets')).toContain('installed 1.0.0, update available');

        expect(await run(`admin dashboard update ${TICKETS}`)).toBe(`Updated ${TICKETS} from 1.0.0 to 1.1.0.`);
        expect(await run(`admin dashboard update ${TICKETS}`)).toBe(`${TICKETS} is already at 1.1.0, the newest version.`);
        expect(await run('admin dashboard update @acme/none')).toBe('Error: not installed: @acme/none');
        expect(await run(`admin dashboard remove ${TICKETS}`)).toBe(`Removed ${TICKETS}@1.1.0 (the page tickets).`);
        expect(await run(`admin dashboard remove ${TICKETS}`)).toBe(`Error: not installed: ${TICKETS}`);
        expect(h.audit.map((a) => [a.event, a.username])).toEqual([
            ['dashboard.plugin.install', 'anonymous'],
            ['dashboard.plugin.update', 'anonymous'],
            ['dashboard.plugin.remove', 'anonymous'],
        ]);
    });

    it('reports an unreachable marketplace', async () => {
        const net = new FakeNet();
        net.marketplaceDown = true;
        const h = await start({ net });
        expect((await runCommand(h.cli, 'admin dashboard search')).text).toBe('Error: marketplace unreachable');
        expect((await runCommand(h.cli, `admin dashboard install ${TICKETS}`)).text).toBe('Error: marketplace unreachable');
    });
});

describe('dashboard marketplace: the kind of every lookup', () => {
    it('sends kind=dashboard on the list, the details and the version records (the marketplace answers 404 for another kind)', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { versions: [{ version: '1.0.0' }, { version: '1.1.0' }] });
        net.filesOnlyInVersionRecord = true;
        const h = await start({ net });
        const send = (r: request.Test) => r.set(auth(h.token));
        expect((await send(request(h.cli.app).get(`${BASE}/plugins`))).status).toBe(200);
        expect((await send(request(h.cli.app).get(`${BASE}/plugins/${encodeURIComponent(TICKETS)}`))).status).toBe(200);
        expect((await send(request(h.cli.app).post(`${BASE}/installed`).send({ name: TICKETS, version: '1.0.0' }))).status).toBe(201);
        expect((await send(request(h.cli.app).put(`${BASE}/installed/${encodeURIComponent(TICKETS)}`).send({}))).status).toBe(200);

        const lookups = net.calls.filter((c) => c.startsWith(`${API}/plugins`));
        expect(lookups.some((c) => c.includes('/versions/'))).toBe(true);
        expect(lookups.length).toBeGreaterThan(3);
        for (const url of lookups) expect(new URL(url).searchParams.get('kind'), url).toBe('dashboard');
    });
});
