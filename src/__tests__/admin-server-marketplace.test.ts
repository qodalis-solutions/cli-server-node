/**
 * Server plugins from the marketplace (admin plugin): the marketplace's kind=server list and details annotated for this
 * server's platform, the trust policy, integrity (the npm record, the marketplace and the tarball), the server range,
 * autoInstall false, install / update / remove (unpacked by the server, restart marked and cleared, installed.json,
 * loaded at the next start), dependencies (the marketplace's pins, the host's trusted list, the server's own copies
 * shared, the refusals), persistence, permissions, path safety, audit and events, and `admin plugins`. No network, no npm.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { defaultHostPackageVersion, isTrustedDependency, readTarballFiles, satisfiesServerRange, tarballPackageJson } from '../../plugins/admin/index';
import { runCommand } from './command-test-helpers';
import {
    FakeServerNet,
    MARKET,
    REGISTRY,
    SBASE,
    SERVER_VERSION,
    bearer,
    cleanupServerHosts,
    makeTarball,
    pluginPackage,
    startServer,
} from './server-marketplace-test-helpers';

afterEach(cleanupServerHosts);

const installedJson = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, 'server-plugins', 'installed.json'), 'utf8')).plugins;

function seeded(): FakeServerNet {
    const net = new FakeServerNet();
    net.publish('weather', { icon: '🌤️', others: { python: 'qodalis-cli-server-plugin-weather', dotnet: 'Qodalis.Cli.Plugin.Weather' }, versions: [{ version: '1.0.0' }, { version: '1.1.0' }] });
    net.publish('jobs', { versions: [{ version: '2.0.0', serverRange: '^99.0.0' }] });
    net.publish('kanban', { verified: false, node: '@acme/cli-server-plugin-kanban', versions: [{ version: '0.1.0' }] });
    net.publish('logs-seq', { node: null, others: { dotnet: 'Qodalis.Cli.Plugin.Logs.Seq' }, versions: [] });
    net.publish('users', {
        versions: [{ version: '1.0.0', npmQodalis: { kind: 'server', autoInstall: false, autoInstallReason: 'replaces the sign-in: set up in code' } }],
    });
    return net;
}

describe('server marketplace: helpers', () => {
    it('reads npm ranges, prereleases compared like releases', () => {
        expect(satisfiesServerRange('1.0.0-beta.31', '^1.0.0-beta.3')).toBe(true);
        expect(satisfiesServerRange('1.0.0-beta.31', '>=1.0.0-beta.30 <2')).toBe(true);
        expect(satisfiesServerRange('1.0.0-beta.31', '^1.0.0')).toBe(false);
        expect(satisfiesServerRange('1.2.3', '~1.2.0')).toBe(true);
        expect(satisfiesServerRange('1.3.0', '~1.2.0')).toBe(false);
        expect(satisfiesServerRange('0.2.5', '^0.2.1')).toBe(true);
        expect(satisfiesServerRange('0.3.0', '^0.2.1')).toBe(false);
        expect(satisfiesServerRange('2.1.0', '1.x || 2.x')).toBe(true);
        expect(satisfiesServerRange('3.0.0', '1 - 2.5.0')).toBe(false);
        expect(satisfiesServerRange('9.9.9', null)).toBe(true);
        expect(satisfiesServerRange('9.9.9', '*')).toBe(true);
        expect(satisfiesServerRange('1.0.0', 'not a range')).toBe(false);
    });

    it('reads a tarball: its files and package.json', () => {
        const tgz = makeTarball({ 'package/package.json': '{"name":"x","version":"1.0.0"}', 'package/lib/a.js': 'x'.repeat(700) });
        const files = readTarballFiles(tgz);
        expect([...files.keys()]).toEqual(['package/package.json', 'package/lib/a.js']);
        expect(files.get('package/lib/a.js')!.length).toBe(700);
        expect(tarballPackageJson(tgz)).toEqual({ name: 'x', version: '1.0.0' });
        expect(() => tarballPackageJson(makeTarball({ 'other/package.json': '{}' }))).toThrow('no package/package.json');
        expect(() => tarballPackageJson(Buffer.from('not gzip'))).toThrow('invalid tarball');
    });
});

describe('server marketplace: browsing', () => {
    it('GET / says the policy, this platform and the server version', async () => {
        const h = await startServer({ net: seeded() });
        expect((await request(h.cli.app).get(SBASE).set(bearer(h.token))).body).toEqual({
            marketplaceUrl: MARKET,
            install: 'verified',
            platform: 'node',
            serverVersion: SERVER_VERSION,
            enabled: true,
        });
    });

    it('lists kind=server for node with this server version, annotated', async () => {
        const h = await startServer({ net: seeded() });
        const res = await request(h.cli.app).get(`${SBASE}/plugins?query=`).set(bearer(h.token));
        expect(res.status).toBe(200);
        expect(h.net.calls[0]).toBe(`${MARKET}/api/v1/qcli/marketplace/plugins?kind=server&platform=node&serverVersion=${encodeURIComponent(SERVER_VERSION)}`);
        const byName = Object.fromEntries(res.body.items.map((i: { name: string }) => [i.name, i]));
        // logs-seq has no Node package: the marketplace leaves it out
        expect(Object.keys(byName).sort()).toEqual(['jobs', 'kanban', 'users', 'weather']);
        expect(byName.weather).toMatchObject({
            kind: 'server',
            platforms: { node: { package: '@qodalis/cli-server-plugin-weather', registry: 'npm', latest: '1.1.0' } },
            platform: { package: '@qodalis/cli-server-plugin-weather', latest: '1.1.0', installed: null, compatible: true },
            otherPlatforms: ['python', 'dotnet'],
            autoInstall: true,
            updateAvailable: false,
            allowed: true,
        });
        expect(byName.jobs).toMatchObject({ platform: { compatible: false, latest: null, reason: `needs server ^99.0.0 (this server has ${SERVER_VERSION})` }, allowed: false, blockedReason: `needs server ^99.0.0 (this server has ${SERVER_VERSION})` });
        expect(byName.kanban).toMatchObject({ allowed: false, blockedReason: 'unverified publisher' });
    });

    it('details: every platform version, Node ones annotated; autoInstall from the npm record', async () => {
        const h = await startServer({ net: seeded() });
        const weather = (await request(h.cli.app).get(`${SBASE}/plugins/weather`).set(bearer(h.token))).body;
        expect(weather.versions.map((v: { platform: string; version: string; allowed?: boolean }) => `${v.platform}:${v.version}:${v.allowed}`)).toEqual([
            'node:1.0.0:true',
            'node:1.1.0:true',
            'python:1.0.0b31:undefined',
            'dotnet:1.0.0b31:undefined',
        ]);
        expect(weather.platform).toMatchObject({ latest: '1.1.0', compatible: true });
        const users = (await request(h.cli.app).get(`${SBASE}/plugins/users`).set(bearer(h.token))).body;
        expect(users).toMatchObject({ autoInstall: false, autoInstallReason: 'replaces the sign-in: set up in code', allowed: false, blockedReason: 'needs setup in code' });
        const seq = (await request(h.cli.app).get(`${SBASE}/plugins/logs-seq`).set(bearer(h.token))).body;
        expect(seq).toMatchObject({ platform: null, otherPlatforms: ['dotnet'], allowed: false, blockedReason: 'not available for node' });
        expect((await request(h.cli.app).get(`${SBASE}/plugins/nothing`).set(bearer(h.token))).status).toBe(404);
        expect((await request(h.cli.app).get(`${SBASE}/plugins/..%2F..%2Fetc`).set(bearer(h.token))).status).toBe(400);
    });

    it('an unreachable marketplace is a 502', async () => {
        const net = seeded();
        net.marketplaceDown = true;
        const h = await startServer({ net });
        const res = await request(h.cli.app).get(`${SBASE}/plugins`).set(bearer(h.token));
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'marketplace unreachable' });
    });
});

describe('server marketplace: install, update, remove', () => {
    it('installs the Node package: verified tarball unpacked by the server, installed.json, restart marked; loaded at the next start', async () => {
        const net = seeded();
        const h = await startServer({ net });
        const res = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'weather' });
        expect(res.status).toBe(202);
        expect(res.body).toMatchObject({
            name: 'weather',
            package: '@qodalis/cli-server-plugin-weather',
            version: '1.1.0',
            title: 'Weather',
            icon: '🌤️',
            installedBy: 'admin',
            status: 'pending',
            loadedVersion: null,
            restartRequired: true,
        });
        // the verified tarball, unpacked by the server (no npm, no install scripts) and kept
        const dir = join(h.dataDir, 'server-plugins');
        expect(readdirSync(join(dir, 'tarballs'))).toEqual(['@qodalis+cli-server-plugin-weather-1.1.0.tgz']);
        expect(JSON.parse(readFileSync(join(dir, 'node_modules', '@qodalis', 'cli-server-plugin-weather', 'package.json'), 'utf8')).version).toBe('1.1.0');
        expect(existsSync(join(dir, 'node_modules', '@qodalis', 'cli-server-plugin-weather', 'node_modules'))).toBe(false);
        expect(installedJson(h.dataDir)).toEqual([
            expect.objectContaining({ name: 'weather', package: '@qodalis/cli-server-plugin-weather', version: '1.1.0', integrity: expect.stringMatching(/^sha512-/), installedBy: 'admin' }),
        ]);
        expect(h.cli.restart.pending()).toEqual([expect.objectContaining({ id: 'plugin:weather', source: 'plugins', description: 'Install weather 1.1.0' })]);
        expect(h.audit.map((a) => [a.event, a.details])).toEqual([['server.plugin.install', '@qodalis/cli-server-plugin-weather@1.1.0']]);
        expect(h.events.filter((e) => e.type === 'server:plugins-changed').map((e) => e.data)).toEqual([
            { action: 'install', name: 'weather', package: '@qodalis/cli-server-plugin-weather', version: '1.1.0' },
        ]);
        // Not running yet
        expect(h.cli.registry.findProcessor('hello')).toBeUndefined();
        expect((await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'weather' })).status).toBe(409);

        // The next start loads it
        const next = await startServer({ net, dataDir: h.dataDir });
        expect(next.cli.registry.findProcessor('hello')).toBeDefined();
        expect((await runCommand(next.cli, 'hello')).text).toBe('hi from 1.1.0');
        const installed = (await request(next.cli.app).get(`${SBASE}/installed`).set(bearer(next.token))).body;
        expect(installed).toEqual([expect.objectContaining({ name: 'weather', status: 'loaded', loadedVersion: '1.1.0', updateAvailable: false })]);
        const packages = (await request(next.cli.app).get('/api/v1/qcli/plugins/installed').set(bearer(next.token))).body;
        expect(packages).toContainEqual(expect.objectContaining({ id: '@qodalis/cli-server-plugin-weather', version: '1.1.0', source: 'marketplace' }));
        expect(next.cli.restart.pending()).toEqual([]);
    });

    it('update and remove mark a restart; going back to what runs clears it', async () => {
        const net = seeded();
        const first = await startServer({ net });
        await request(first.cli.app).post(`${SBASE}/installed`).set(bearer(first.token)).send({ name: 'weather', version: '1.0.0' }).expect(202);
        const h = await startServer({ net, dataDir: first.dataDir });
        expect((await runCommand(h.cli, 'hello')).text).toBe('hi from 1.0.0');
        expect(h.cli.restart.pending()).toEqual([]);

        const up = await request(h.cli.app).put(`${SBASE}/installed/weather`).set(bearer(h.token)).send({});
        expect(up.status).toBe(202);
        expect(up.body).toMatchObject({ version: '1.1.0', previousVersion: '1.0.0', changed: true, status: 'pending', loadedVersion: '1.0.0', restartRequired: true });
        expect(h.cli.restart.pending()).toEqual([expect.objectContaining({ id: 'plugin:weather', description: 'Update weather 1.0.0 -> 1.1.0' })]);
        expect(readdirSync(join(h.dataDir, 'server-plugins', 'tarballs'))).toEqual(['@qodalis+cli-server-plugin-weather-1.1.0.tgz']);
        const same = await request(h.cli.app).put(`${SBASE}/installed/weather`).set(bearer(h.token)).send({ version: '1.1.0' });
        expect(same.status).toBe(200);
        expect(same.body).toMatchObject({ changed: false, restartRequired: true });

        // Back to the running version: nothing to restart for
        const back = await request(h.cli.app).put(`${SBASE}/installed/weather`).set(bearer(h.token)).send({ version: '1.0.0' });
        expect(back.body).toMatchObject({ status: 'loaded', restartRequired: false });
        expect(h.cli.restart.pending()).toEqual([]);

        const removed = await request(h.cli.app).delete(`${SBASE}/installed/weather`).set(bearer(h.token));
        expect(removed.status).toBe(202);
        expect(removed.body).toMatchObject({ name: 'weather', status: 'removed', restartRequired: true });
        expect(existsSync(join(h.dataDir, 'server-plugins', 'node_modules', '@qodalis', 'cli-server-plugin-weather'))).toBe(false);
        expect(installedJson(h.dataDir)).toEqual([]);
        expect(h.cli.restart.pending()).toEqual([expect.objectContaining({ id: 'plugin:weather', description: 'Remove weather 1.0.0' })]);
        // Still running until the restart, listed as removed
        expect((await runCommand(h.cli, 'hello')).text).toBe('hi from 1.0.0');
        expect((await request(h.cli.app).get(`${SBASE}/installed`).set(bearer(h.token))).body).toEqual([expect.objectContaining({ name: 'weather', status: 'removed' })]);
        expect(h.audit.map((a) => a.event)).toEqual(['server.plugin.update', 'server.plugin.update', 'server.plugin.remove']);

        const after = await startServer({ net, dataDir: h.dataDir });
        expect(after.cli.registry.findProcessor('hello')).toBeUndefined();
        expect((await request(after.cli.app).delete(`${SBASE}/installed/weather`).set(bearer(after.token))).status).toBe(404);
    });

    it('removing an install that never ran clears its restart', async () => {
        const h = await startServer({ net: seeded() });
        await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'weather' }).expect(202);
        const res = await request(h.cli.app).delete(`${SBASE}/installed/weather`).set(bearer(h.token));
        expect(res.body).toMatchObject({ restartRequired: false });
        expect(h.cli.restart.pending()).toEqual([]);
    });

    it('the trust policy: verified only by default, listed, off', async () => {
        const net = seeded();
        const verified = await startServer({ net });
        const res = await request(verified.cli.app).post(`${SBASE}/installed`).set(bearer(verified.token)).send({ name: 'kanban' });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'publisher not verified' });
        const listed = await startServer({ net, install: 'listed' });
        expect((await request(listed.cli.app).post(`${SBASE}/installed`).set(bearer(listed.token)).send({ name: 'kanban' })).status).toBe(202);
        const off = await startServer({ net, install: 'off' });
        expect((await request(off.cli.app).post(`${SBASE}/installed`).set(bearer(off.token)).send({ name: 'weather' })).body).toEqual({ error: 'install disabled' });
        expect((await request(off.cli.app).get(`${SBASE}/plugins`).set(bearer(off.token))).body.items[0]).toMatchObject({ allowed: false, blockedReason: 'install disabled' });
        expect(existsSync(join(verified.dataDir, 'server-plugins', 'node_modules'))).toBe(false);
    });

    it('integrity: a tampered tarball and a marketplace that disagrees with npm install nothing', async () => {
        const net = new FakeServerNet();
        net.publish('tampered', { versions: [{ version: '1.0.0', tampered: true }] });
        net.publish('disagree', { versions: [{ version: '1.0.0', marketplaceIntegrity: 'sha512-AAAA' }] });
        const h = await startServer({ net });
        const a = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'tampered' });
        expect(a.status).toBe(502);
        expect(a.body).toEqual({ error: 'integrity mismatch: @qodalis/cli-server-plugin-tampered@1.0.0' });
        const b = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'disagree' });
        expect(b.body).toEqual({ error: 'integrity mismatch: the marketplace and the npm registry disagree' });
        // nothing downloaded for the second, nothing stored for either
        expect(net.calls.filter((c) => c.includes('/-/tarballs/')).length).toBe(1);
        expect(existsSync(join(h.dataDir, 'server-plugins', 'node_modules'))).toBe(false);
        expect(existsSync(join(h.dataDir, 'server-plugins', 'installed.json'))).toBe(false);
        expect(h.cli.restart.pending()).toEqual([]);
    });

    it('the server range: the version record and the package itself', async () => {
        const net = seeded();
        net.publish('peer', {
            versions: [{ version: '1.0.0', serverRange: null, files: pluginPackage('@qodalis/cli-server-plugin-peer', '1.0.0', { peer: { '@qodalis/cli-server-abstractions': '^7.0.0' } }) }],
        });
        const h = await startServer({ net });
        const jobs = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'jobs' });
        expect(jobs.status).toBe(400);
        expect(jobs.body.error).toBe(`incompatible: @qodalis/cli-server-plugin-jobs@2.0.0 needs server ^99.0.0 (this server has ${SERVER_VERSION})`);
        const peer = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'peer' });
        expect(peer.body.error).toBe(`incompatible: @qodalis/cli-server-plugin-peer@1.0.0 needs server ^7.0.0 (this server has ${SERVER_VERSION})`);
        expect(existsSync(join(h.dataDir, 'server-plugins', 'node_modules'))).toBe(false);
    });

    it('refuses what needs the host: autoInstall false (npm record or tarball), no entry, not a server plugin, not for node', async () => {
        const net = seeded();
        net.publish('noentry', { versions: [{ version: '1.0.0', files: pluginPackage('@qodalis/cli-server-plugin-noentry', '1.0.0', { qodalis: { entry: undefined } }) }] });
        net.publish('web', { versions: [{ version: '1.0.0', files: pluginPackage('@qodalis/cli-server-plugin-web', '1.0.0', { qodalis: null }) }] });
        net.publish('manual', { versions: [{ version: '1.0.0', files: pluginPackage('@qodalis/cli-server-plugin-manual', '1.0.0', { qodalis: { autoInstall: false, autoInstallReason: 'set up in code' } }), npmQodalis: { kind: 'server' } }] });
        const h = await startServer({ net });
        const post = (name: string) => request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name });
        expect((await post('users')).body).toEqual({ error: 'needs setup in code: replaces the sign-in: set up in code' });
        expect((await post('manual')).body).toEqual({ error: 'needs setup in code: set up in code' });
        expect((await post('noentry')).body).toEqual({ error: '@qodalis/cli-server-plugin-noentry declares no qodalis.entry' });
        expect((await post('web')).body).toEqual({ error: 'not a server plugin package: @qodalis/cli-server-plugin-web (no qodalis.kind "server")' });
        expect((await post('logs-seq')).body).toEqual({ error: 'not available for node: logs-seq' });
        expect(existsSync(join(h.dataDir, 'server-plugins', 'node_modules'))).toBe(false);
    });

    it('a package the host installed is refused; a failed dependency stores nothing', async () => {
        const net = seeded();
        const h = await startServer({ net, configure: (cli) => cli.builder.addInstalledPlugin({ id: '@qodalis/cli-server-plugin-weather', name: 'Weather' }) });
        expect((await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'weather' })).body).toEqual({
            error: 'already installed by the host: @qodalis/cli-server-plugin-weather',
        });
        const pin = net.publishPackage('left-pad', '1.3.0');
        net.publishPackage('left-pad', '1.3.0', { tampered: true });
        net.publish('other', {
            versions: [{ version: '1.0.0', files: pluginPackage('@qodalis/cli-server-plugin-other', '1.0.0', { deps: { 'left-pad': '^1.3.0' } }), dependencies: [{ id: 'left-pad', version: '1.3.0', integrity: pin }] }],
        });
        const res = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'other' });
        expect(res.status).toBe(502);
        expect(res.body.error).toBe('integrity mismatch: left-pad@1.3.0');
        expect(existsSync(join(h.dataDir, 'server-plugins', 'tarballs'))).toBe(false);
        expect(existsSync(join(h.dataDir, 'server-plugins', 'installed.json'))).toBe(false);
        expect(existsSync(join(h.dataDir, 'server-plugins', 'node_modules'))).toBe(false);
    });

    it('path safety: invalid names and versions are refused before anything is fetched', async () => {
        const h = await startServer({ net: seeded() });
        for (const name of ['../etc', '..', 'a/b/c', 'UPPER', '', '@x/../y']) {
            const res = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name });
            expect(res.status, name).toBe(400);
        }
        expect((await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'weather', version: '../1' })).body).toEqual({ error: 'invalid version' });
        expect((await request(h.cli.app).put(`${SBASE}/installed/..%2F..`).set(bearer(h.token)).send({})).status).toBe(400);
        expect((await request(h.cli.app).delete(`${SBASE}/installed/..%2F..`).set(bearer(h.token))).status).toBe(400);
        expect(h.net.calls).toEqual([]);
    });

    it('serverPlugins: false: browsing only, installs refused', async () => {
        const h = await startServer({ net: seeded(), serverPlugins: false });
        expect(h.cli.serverPlugins.enabled).toBe(false);
        expect((await request(h.cli.app).get(SBASE).set(bearer(h.token))).body.enabled).toBe(false);
        expect((await request(h.cli.app).get(`${SBASE}/plugins/weather`).set(bearer(h.token))).body).toMatchObject({ allowed: false, blockedReason: 'server plugins disabled' });
        expect((await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'weather' })).body).toEqual({ error: 'server plugins disabled' });
    });
});

describe('server marketplace: permissions', () => {
    it('reading needs admin:access, changes plugins:install (dashboard:install is not enough)', async () => {
        const h = await startServer({
            net: seeded(),
            users: { viewer: ['admin:access'], dash: ['admin:access', 'dashboard:install'], installer: ['admin:access', 'plugins:install'], outsider: ['files:read'] },
        });
        expect((await request(h.cli.app).get(`${SBASE}/plugins`).set(bearer(h.tokens.outsider))).status).toBe(403);
        expect((await request(h.cli.app).get(`${SBASE}/plugins`).set(bearer(h.tokens.viewer))).status).toBe(200);
        for (const who of ['viewer', 'dash']) {
            const denied = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.tokens[who])).send({ name: 'weather' });
            expect(denied.status, who).toBe(403);
            expect(denied.body.error).toContain('plugins:install');
        }
        const ok = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.tokens.installer)).send({ name: 'weather' });
        expect(ok.status).toBe(202);
        expect(ok.body.installedBy).toBe('installer');
        expect((await request(h.cli.app).delete(`${SBASE}/installed/weather`).set(bearer(h.tokens.viewer))).status).toBe(403);
        const catalog = await request(h.cli.app).get('/api/v1/qcli/permissions?all=true').set(bearer(h.tokens.root));
        expect(catalog.body).toContainEqual({ name: 'plugins:install', description: 'Install, update and remove server plugins from the marketplace', group: 'Server', surface: 'cli' });
    });
});

describe('server marketplace: admin plugins command', () => {
    it('search, install, installed, update, remove', async () => {
        const net = seeded();
        const h = await startServer({ net });
        const run = (line: string) => runCommand(h.cli, line).then((r) => r.text);
        const search = await run('admin plugins search');
        expect(search.split('\n')[0].split(/\s{2,}/)).toEqual(['Plugin', 'Package', 'Version', 'Platforms', 'Publisher', 'Status']);
        expect(search).toMatch(/^weather\s+@qodalis\/cli-server-plugin-weather\s+1\.1\.0\s+node, python, dotnet\s+qodalis \(verified\)\s+installable$/m);
        expect(search).toMatch(/^jobs\s+.*blocked: needs server \^99\.0\.0/m);
        expect(search).toContain('blocked: unverified publisher');
        expect(await run('admin plugins search nothing-like-this')).toBe('No server plugins match "nothing-like-this".');

        expect(await run('admin plugins installed')).toBe(`No server plugins installed from the marketplace (${MARKET}, install: verified; admin plugins search <query> finds some).`);
        expect(await run('admin plugins install weather@1.0.0')).toBe(
            'Installed weather: @qodalis/cli-server-plugin-weather@1.0.0.\nRestart the server to apply it: admin restart (or the dashboard).',
        );
        expect(await run('admin plugins install weather')).toBe('Error: already installed: weather@1.0.0');
        expect(await run('admin plugins install kanban')).toBe('Error: publisher not verified');
        expect(await run('admin plugins install ../../etc')).toBe('Error: invalid plugin name');
        expect(await run('admin plugins install')).toBe('Error: name one plugin: admin plugins install <name>[@version]');
        const installed = (await run('admin plugins installed')).split('\n');
        expect(installed[0]).toBe(`1 server plugin(s) from ${MARKET} (install: verified)`);
        expect(installed[2]).toMatch(/^weather  @qodalis\/cli-server-plugin-weather  1\.0\.0 \(update available\)  pending restart  \d{4}-\d\d-\d\d \d\d:\d\d:\d\d  anonymous$/);
        expect(JSON.parse(await run('admin plugins installed --json'))).toEqual([expect.objectContaining({ name: 'weather', status: 'pending' })]);
        expect(await run('admin plugins update weather')).toBe('Updated weather from 1.0.0 to 1.1.0.\nRestart the server to apply it: admin restart (or the dashboard).');
        expect(await run('admin plugins update weather')).toBe('weather is already at 1.1.0.');
        expect(await run('admin plugins remove weather')).toBe(
            'Removed weather (@qodalis/cli-server-plugin-weather@1.1.0).\nNo restart needed: the server already runs this.',
        );
        // the modules list is still `admin plugins`
        expect(await run('admin plugins')).toContain('admin');
    });

    it('install, update and remove need plugins:install; search and installed admin:access', async () => {
        const h = await startServer({ net: seeded(), users: { viewer: ['admin:access', 'commands:execute'], installer: ['admin:access', 'commands:execute', 'plugins:install'] } });
        expect((await runCommand(h.cli, 'admin plugins search', h.tokens.viewer)).status).toBe(200);
        expect((await runCommand(h.cli, 'admin plugins installed', h.tokens.viewer)).status).toBe(200);
        expect((await runCommand(h.cli, 'admin plugins install weather', h.tokens.viewer)).status).toBe(403);
        const ok = await runCommand(h.cli, 'admin plugins install weather', h.tokens.installer);
        expect(ok.text).toContain('Installed weather');
        expect(installedJson(h.dataDir)[0].installedBy).toBe('installer');
    });
});

describe('server marketplace: registry calls', () => {
    it('reads the npm record of the chosen version', async () => {
        const h = await startServer({ net: seeded() });
        await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'weather' }).expect(202);
        expect(h.net.calls).toContain(`${REGISTRY}/@qodalis%2fcli-server-plugin-weather/1.1.0`);
    });
});

describe('server marketplace: dependencies', () => {
    const PKG = '@qodalis/cli-server-plugin-deps';
    const pluginDir = (dataDir: string) => join(dataDir, 'server-plugins', 'node_modules', '@qodalis', 'cli-server-plugin-deps');
    /** A plugin whose command answers the versions it required: its own dependency and the server's express. */
    const depsPlugin = (deps: Record<string, string>) =>
        pluginPackage(PKG, '1.0.0', {
            deps,
            entry: `exports.createPlugin = async () => ({
                name: 'deps', version: '1.0.0', description: 'test', author: { name: 't' },
                processors: [{ command: 'deps', description: 'versions', handleAsync: async () => require('left-pad').version + ' ' + require('tiny-dep').version + ' ' + require('express/package.json').version + ' ' + (require.resolve('express').includes('server-plugins') ? 'own' : 'host') }],
            });`,
        });
    const DEPS = { 'left-pad': '^1.3.0', express: '^4.0.0', '@qodalis/cli-server-abstractions': '^1.0.0-beta.1' };
    const EXPRESS: string = require('express/package.json').version;
    const post = (h: Awaited<ReturnType<typeof startServer>>, name = 'deps') => request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name });

    it('pinned by the marketplace: exactly the pins, each checked, in the plugin\'s own node_modules; the server\'s copies shared, never installed', async () => {
        const net = new FakeServerNet();
        const leftPad = net.publishPackage('left-pad', '1.3.0', { deps: { 'tiny-dep': '^2.0.0' } });
        net.publishPackage('left-pad', '1.9.0', { latest: true });
        const tiny = net.publishPackage('tiny-dep', '2.1.0');
        net.publish('deps', {
            versions: [{ version: '1.0.0', files: depsPlugin(DEPS), dependencies: [{ id: 'left-pad', version: '1.3.0', integrity: leftPad, range: '^1.3.0' }, { id: 'tiny-dep', version: '2.1.0', integrity: tiny, range: '^2.0.0' }] }],
        });
        const h = await startServer({ net, hostPackages: { express: EXPRESS } });
        const res = await post(h);
        expect(res.status).toBe(202);
        const modules = join(pluginDir(h.dataDir), 'node_modules');
        expect(readdirSync(modules).sort()).toEqual(['left-pad', 'tiny-dep']);
        expect(JSON.parse(readFileSync(join(modules, 'left-pad', 'package.json'), 'utf8')).version).toBe('1.3.0');
        expect(existsSync(join(h.dataDir, 'server-plugins', 'node_modules', 'express'))).toBe(false);
        expect(existsSync(join(modules, '@qodalis'))).toBe(false);
        expect(installedJson(h.dataDir)[0].dependencies).toEqual([
            { id: 'left-pad', version: '1.3.0', integrity: leftPad, source: 'pinned' },
            { id: 'tiny-dep', version: '2.1.0', integrity: tiny, source: 'pinned' },
        ]);
        // no packument read: the pins decide
        expect(net.calls.some((c) => c === `${REGISTRY}/left-pad`)).toBe(false);

        // loaded at the next start: its own dependencies, the server's express
        const next = await startServer({ net, dataDir: h.dataDir });
        expect((await runCommand(next.cli, 'deps')).text).toBe(`1.3.0 2.1.0 ${EXPRESS} host`);
    });

    it('pinned: a dependency without a pin, a pin out of the range, a pin the registry disagrees with are refused; nothing stored', async () => {
        const net = new FakeServerNet();
        const leftPad = net.publishPackage('left-pad', '1.3.0', { deps: { 'tiny-dep': '^2.0.0' } });
        const old = net.publishPackage('left-pad', '1.0.0');
        net.publishPackage('tiny-dep', '2.1.0');
        net.publish('deps', { versions: [{ version: '1.0.0', files: depsPlugin(DEPS), dependencies: [{ id: 'left-pad', version: '1.3.0', integrity: leftPad }] }] });
        net.publish('old', { node: '@qodalis/cli-server-plugin-deps', versions: [{ version: '1.0.0', files: depsPlugin(DEPS), dependencies: [{ id: 'left-pad', version: '1.0.0', integrity: old }] }] });
        net.publish('liar', { node: '@qodalis/cli-server-plugin-deps', versions: [{ version: '1.0.0', files: depsPlugin(DEPS), dependencies: [{ id: 'left-pad', version: '1.3.0', integrity: old }] }] });
        const h = await startServer({ net, hostPackages: { express: EXPRESS }, trustedDependencies: ['*'] });
        const unpinned = await post(h);
        expect(unpinned.status).toBe(400);
        expect(unpinned.body).toEqual({ error: 'untrusted dependency: tiny-dep (not pinned by the marketplace)' });
        expect((await post(h, 'old')).body).toEqual({ error: 'incompatible dependency: left-pad@^1.3.0 (the marketplace pins 1.0.0)' });
        const liar = await post(h, 'liar');
        expect(liar.status).toBe(502);
        expect(liar.body).toEqual({ error: 'integrity mismatch: the marketplace and the npm registry disagree on left-pad@1.3.0' });
        expect(existsSync(join(h.dataDir, 'server-plugins', 'node_modules'))).toBe(false);
        expect(existsSync(join(h.dataDir, 'server-plugins', 'installed.json'))).toBe(false);
    });

    it('no pins: only what the server trusts (names, @scope/*, prefix*), the newest version in the range, checked against the registry', async () => {
        const net = new FakeServerNet();
        net.publishPackage('left-pad', '1.3.0', { deps: { 'tiny-dep': '^2.0.0' } });
        net.publishPackage('left-pad', '1.4.0', { deps: { 'tiny-dep': '^2.0.0' } });
        net.publishPackage('left-pad', '2.0.0');
        net.publishPackage('tiny-dep', '2.1.0');
        net.publish('deps', { versions: [{ version: '1.0.0', files: depsPlugin(DEPS) }] });

        const none = await startServer({ net, hostPackages: { express: EXPRESS } });
        const refused = await post(none);
        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ error: 'untrusted dependency: left-pad (the marketplace pins none and the server does not trust it)' });
        const partly = await startServer({ net, hostPackages: { express: EXPRESS }, trustedDependencies: ['left-*'] });
        expect((await post(partly)).body).toEqual({ error: 'untrusted dependency: tiny-dep (the marketplace pins none and the server does not trust it)' });

        const h = await startServer({ net, hostPackages: { express: EXPRESS }, trustedDependencies: ['left-*', 'tiny-dep', '@acme/*'] });
        expect((await post(h)).status).toBe(202);
        expect(installedJson(h.dataDir)[0].dependencies).toEqual([
            expect.objectContaining({ id: 'left-pad', version: '1.4.0', source: 'trusted' }),
            expect.objectContaining({ id: 'tiny-dep', version: '2.1.0', source: 'trusted' }),
        ]);
        const next = await startServer({ net, dataDir: h.dataDir });
        expect((await runCommand(next.cli, 'deps')).text).toBe(`1.4.0 2.1.0 ${EXPRESS} host`);
    });

    it('the server\'s own packages: never installed; an incompatible version or a missing server package refused', async () => {
        const net = new FakeServerNet();
        net.publishPackage('left-pad', '1.3.0');
        net.publishPackage('express', '4.21.0');
        net.publish('deps', { versions: [{ version: '1.0.0', files: depsPlugin({ express: '^4.0.0' }), dependencies: [{ id: 'express', version: '4.21.0', integrity: 'sha512-x' }] }] });
        net.publish('needs', {
            node: '@qodalis/cli-server-plugin-needs',
            versions: [{ version: '1.0.0', files: pluginPackage('@qodalis/cli-server-plugin-needs', '1.0.0', { deps: { '@qodalis/cli-server-plugin-billing': '^1.0.0' } }) }],
        });
        const old = await startServer({ net, hostPackages: { express: '3.21.0' }, trustedDependencies: ['*'] });
        const res = await post(old);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'incompatible dependency: express@^4.0.0 (the server has 3.21.0)' });
        // a pin for a package the server has is not used: the server's copy
        const ok = await startServer({ net, hostPackages: { express: EXPRESS } });
        expect((await post(ok)).status).toBe(202);
        expect(existsSync(join(pluginDir(ok.dataDir), 'node_modules'))).toBe(false);
        expect(installedJson(ok.dataDir)[0].dependencies).toBeUndefined();
        const host = await startServer({ net, trustedDependencies: ['*'], hostPackages: { '@qodalis/cli-server-plugin-billing': null } });
        expect((await post(host, 'needs')).body).toEqual({ error: 'incompatible dependency: @qodalis/cli-server-plugin-billing@^1.0.0 (a server package the host does not have)' });
    });

    it('the host\'s packages by default: read from what the server resolves', () => {
        expect(defaultHostPackageVersion('express')).toBe(EXPRESS);
        expect(defaultHostPackageVersion('@qodalis/cli-server-abstractions')).toMatch(/^\d+\.\d+\.\d+/);
        expect(defaultHostPackageVersion('no-such-package-qcli-test')).toBeUndefined();
    });

    it('trusted patterns', () => {
        expect(isTrustedDependency('left-pad', ['left-pad'])).toBe(true);
        expect(isTrustedDependency('left-pad', ['left-*'])).toBe(true);
        expect(isTrustedDependency('@acme/x', ['@acme/*'])).toBe(true);
        expect(isTrustedDependency('@acmex/x', ['@acme/*'])).toBe(false);
        expect(isTrustedDependency('right-pad', ['left-*', 'pad'])).toBe(false);
        expect(isTrustedDependency('anything', [])).toBe(false);
    });
});

describe('server marketplace: the kind of every lookup', () => {
    it('sends kind=server on the list and the details, installs and updates (the marketplace answers 404 for another kind)', async () => {
        const net = seeded();
        const h = await startServer({ net });
        const send = (r: request.Test) => r.set(bearer(h.token));
        expect((await send(request(h.cli.app).get(`${SBASE}/plugins`))).status).toBe(200);
        expect((await send(request(h.cli.app).get(`${SBASE}/plugins/weather`))).status).toBe(200);
        expect((await send(request(h.cli.app).post(`${SBASE}/installed`).send({ name: 'weather', version: '1.0.0' }))).status).toBe(202);
        expect((await send(request(h.cli.app).put(`${SBASE}/installed/weather`).send({}))).status).toBe(202);

        const lookups = net.calls.filter((c) => c.startsWith(`${MARKET}/api/v1/qcli/marketplace/plugins`));
        expect(lookups.length).toBeGreaterThan(3);
        for (const url of lookups) expect(new URL(url).searchParams.get('kind'), url).toBe('server');
    });
});
