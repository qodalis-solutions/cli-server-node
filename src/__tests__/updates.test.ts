/**
 * The update checker: dashboard and server plugins installed from the marketplace with a newer version (Update),
 * plugins added in code (Update in code, with the install commands), the server package (npm), the notifications it
 * publishes and resolves, its schedule (a job of the jobs plugin, else a timer), its persisted result, and
 * `/api/v1/qcli/updates` with its permissions.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliNotificationService } from '../notifications';
import { UpdateChecker, updateNotificationKey, type UpdateCheckerDeps } from '../../plugins/admin/index';
import { BASE, FakeNet, JOBS, TICKETS, auth, cleanupMarketplaceHosts, response, start, startProtected } from './dashboard-marketplace-test-helpers';

const V1 = '/api/v1/qcli';
const UPDATES = `${V1}/updates`;
const REGISTRY = 'https://registry.test';
const CORE = '@qodalis/cli-server-node';
const viewer = { userId: 'u', can: () => true };

const dirs: string[] = [];
// The marketplace helpers' servers keep their data (updates.json, notifications.json) in QCLI_DATA_DIR
const savedDataDir = process.env.QCLI_DATA_DIR;
beforeEach(() => {
    process.env.QCLI_DATA_DIR = temp();
});
afterEach(() => {
    if (savedDataDir === undefined) delete process.env.QCLI_DATA_DIR;
    else process.env.QCLI_DATA_DIR = savedDataDir;
    cleanupMarketplaceHosts();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.useRealTimers();
});
const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'qcli-updates-'));
    dirs.push(d);
    return d;
};

/** A server marketplace answering `search` with these annotated items, and its installed list. */
function fakeServerMarketplace(items: unknown[], records: Array<{ name: string; version: string }> = []) {
    return {
        npmRegistry: REGISTRY,
        search: vi.fn(async () => ({ items, total: items.length, page: 1, pageSize: 100 })),
        installedRecords: () => records,
    };
}

/** npm's `<package>/latest` for the server package. */
function npm(versions: Record<string, string | null>, down = false) {
    return vi.fn(async (url: string) => {
        if (down) throw new TypeError('fetch failed');
        const m = /^https:\/\/registry\.test\/(.+)\/latest$/.exec(url);
        const pkg = m ? decodeURIComponent(m[1]) : '';
        const v = versions[pkg];
        return v ? response(200, { name: pkg, version: v }) : response(404, { error: 'not found' });
    });
}

function checker(deps: Partial<UpdateCheckerDeps> & { server?: unknown }, notifications = new CliNotificationService()) {
    const c = new UpdateChecker({
        serverVersion: () => '1.0.0-beta.33',
        npmRegistry: REGISTRY,
        fetch: npm({ [CORE]: '1.0.0-beta.33' }),
        notifications: () => notifications,
        ...deps,
    } as UpdateCheckerDeps);
    return { c, notifications };
}

const weatherItem = (installed: { version: string; source: 'marketplace' | 'code' } | null, latest = '1.2.0', extra: Record<string, unknown> = {}) => ({
    name: 'weather',
    title: 'Weather',
    icon: '🌤️',
    platforms: {
        node: { package: '@qodalis/cli-server-plugin-weather', latest },
        python: { package: 'qodalis-cli-server-plugin-weather', latest: '1.2.0b1' },
        dotnet: { package: 'Qodalis.Cli.Plugin.Weather', latest: '1.2.0', install: 'dotnet add package Qodalis.Cli.Plugin.Weather --version 1.2.0' },
    },
    platform: { package: '@qodalis/cli-server-plugin-weather', latest, installed: installed?.version ?? null, compatible: true },
    installed,
    updateAvailable: !!installed,
    allowed: true,
    ...extra,
});

describe('UpdateChecker', () => {
    it('server plugins: marketplace installs can update here, code-added ones in code with the install command per platform', async () => {
        const server = fakeServerMarketplace([
            weatherItem({ version: '1.0.0', source: 'marketplace' }),
            { ...weatherItem({ version: '0.9.0', source: 'code' }), name: 'jobs', title: 'Jobs', platform: { package: '@qodalis/cli-server-plugin-jobs', latest: '1.2.0', installed: null, compatible: true }, platforms: { node: { package: '@qodalis/cli-server-plugin-jobs' }, python: { package: 'qodalis-cli-server-plugin-jobs', latest: '1.2.0b1' } } },
            { ...weatherItem(null), name: 'other' },
            { ...weatherItem({ version: '1.0.0', source: 'marketplace' }, '1.1.0', { allowed: false, blockedReason: 'unverified publisher' }), name: 'shady' },
        ]);
        const { c, notifications } = checker({ server: server as never });
        const result = await c.check();
        expect(server.search).toHaveBeenCalledWith({ page: 1, pageSize: 100, platform: 'this' });
        expect(result.serverPlugins).toEqual([
            {
                kind: 'server',
                name: 'weather',
                package: '@qodalis/cli-server-plugin-weather',
                title: 'Weather',
                icon: '🌤️',
                current: '1.0.0',
                latest: '1.2.0',
                source: 'marketplace',
                updateAvailable: true,
                canUpdate: true,
            },
            expect.objectContaining({ name: 'shady', canUpdate: false, reason: 'unverified publisher', latest: '1.1.0' }),
        ]);
        expect(result.codePlugins).toEqual([
            expect.objectContaining({
                kind: 'server',
                name: 'jobs',
                source: 'code',
                current: '0.9.0',
                latest: '1.2.0',
                canUpdate: false,
                reason: 'update in code',
                install: { node: 'npm install @qodalis/cli-server-plugin-jobs@1.2.0', python: 'pip install --upgrade qodalis-cli-server-plugin-jobs==1.2.0b1' },
            }),
        ]);
        expect(result.count).toBe(3);
        expect(result.server).toMatchObject({ kind: 'core', current: '1.0.0-beta.33', latest: '1.0.0-beta.33', updateAvailable: false, source: 'npm' });
        expect(result.checkedAt).toEqual(expect.any(String));
        expect(result.error).toBeUndefined();

        const keys = notifications.list(viewer).items.map((n) => n.key).sort();
        expect(keys).toEqual(['update:code:server:@qodalis/cli-server-plugin-jobs', 'update:server:shady', 'update:server:weather']);
        expect(notifications.get('update:server:weather')).toMatchObject({
            kind: 'update',
            severity: 'info',
            title: 'Update available: Weather 1.2.0',
            link: '/plugins?tab=updates',
            requiredPermission: 'updates:read',
        });
        expect(notifications.get('update:code:server:@qodalis/cli-server-plugin-jobs')?.title).toBe('Update in code: Jobs 1.2.0');
    });

    it('the server package: newer on npm is an update (and a notification)', async () => {
        const { c, notifications } = checker({ fetch: npm({ [CORE]: '1.0.0-beta.40' }) });
        const result = await c.check();
        expect(result.server).toMatchObject({
            current: '1.0.0-beta.33',
            latest: '1.0.0-beta.40',
            updateAvailable: true,
            canUpdate: false,
            install: { node: 'npm install @qodalis/cli-server-node@1.0.0-beta.40' },
        });
        expect(result.count).toBe(1);
        expect(notifications.get(`update:core:${CORE}`)).toMatchObject({ title: 'Server update available: 1.0.0-beta.40' });
    });

    it('resolves the notifications of updates that no longer apply', async () => {
        const server = fakeServerMarketplace([weatherItem({ version: '1.0.0', source: 'marketplace' })]);
        const { c, notifications } = checker({ server: server as never });
        await c.check();
        expect(notifications.get('update:server:weather')).toBeDefined();
        server.search.mockResolvedValueOnce({ items: [{ ...weatherItem({ version: '1.2.0', source: 'marketplace' }), updateAvailable: false }], total: 1, page: 1, pageSize: 100 });
        const result = await c.check();
        expect(result.serverPlugins).toEqual([]);
        expect(notifications.get('update:server:weather')).toBeUndefined();
    });

    it('a marketplace that does not answer keeps the last items and their notifications, and says why', async () => {
        const server = fakeServerMarketplace([weatherItem({ version: '1.0.0', source: 'marketplace' })]);
        const { c, notifications } = checker({ server: server as never });
        await c.check();
        server.search.mockRejectedValueOnce(new Error('marketplace unreachable'));
        const result = await c.check();
        expect(result.error).toBe('server plugins: marketplace unreachable');
        expect(result.serverPlugins.map((i) => i.name)).toEqual(['weather']);
        expect(notifications.get('update:server:weather')).toBeDefined();
    });

    it('npm down: says so and keeps the last server item', async () => {
        const fetch = npm({ [CORE]: '1.0.0-beta.40' });
        const { c } = checker({ fetch });
        await c.check();
        fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        const result = await c.check();
        expect(result.error).toBe('server package: npm registry unreachable');
        expect(result.server).toMatchObject({ latest: '1.0.0-beta.40', updateAvailable: true });
    });

    it('joins a check already running', async () => {
        const server = fakeServerMarketplace([]);
        const { c } = checker({ server: server as never });
        const [a, b] = await Promise.all([c.check(), c.check()]);
        expect(server.search).toHaveBeenCalledTimes(1);
        expect(a).toEqual(b);
    });

    it('keeps the last result across a restart', async () => {
        const file = join(temp(), 'updates.json');
        const server = fakeServerMarketplace([weatherItem({ version: '1.0.0', source: 'marketplace' })]);
        await checker({ server: server as never, file, fetch: npm({ [CORE]: '1.0.0-beta.40' }) }).c.check();
        const again = checker({ server: server as never, file }).c.result();
        expect(again).toMatchObject({ count: 2, checking: false, serverPlugins: [{ name: 'weather' }], server: { latest: '1.0.0-beta.40', updateAvailable: true } });
        // the server was updated in code since: its running version is read again
        const updated = checker({ server: server as never, file, serverVersion: () => '1.0.0-beta.40' }).c.result();
        expect(updated).toMatchObject({ count: 1, server: { current: '1.0.0-beta.40', updateAvailable: false } });
    });

    it('refreshInstalled drops updated or removed marketplace plugins without asking the marketplace', async () => {
        const records = [{ name: 'weather', version: '1.0.0' }];
        const server = fakeServerMarketplace([weatherItem({ version: '1.0.0', source: 'marketplace' })], records);
        const { c, notifications } = checker({ server: server as never });
        await c.check();
        c.refreshInstalled();
        expect(c.result().serverPlugins).toHaveLength(1);
        records[0].version = '1.2.0';
        c.refreshInstalled();
        expect(c.result()).toMatchObject({ serverPlugins: [], count: 0 });
        expect(notifications.get('update:server:weather')).toBeUndefined();
        expect(server.search).toHaveBeenCalledTimes(1);
    });

    it('schedules a job of the jobs plugin when one is mounted, else a timer; the first check after the initial delay', async () => {
        vi.useFakeTimers();
        const register = vi.fn(() => 'updates:check');
        const server = fakeServerMarketplace([]);
        const { c } = checker({ server: server as never, scheduler: () => ({ register, getRegistration: () => undefined }) });
        c.start();
        expect(register).toHaveBeenCalledWith(expect.objectContaining({ executeAsync: expect.any(Function) }), expect.objectContaining({ id: 'updates:check', interval: '21600s', group: 'system' }));
        expect(server.search).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(server.search).toHaveBeenCalledTimes(1);
        // the job runs the check
        const job = (register.mock.calls[0] as unknown as [{ executeAsync: (ctx: unknown) => Promise<void> }])[0];
        await job.executeAsync({ logger: { info: () => {}, debug: () => {}, warning: () => {}, error: () => {} } });
        expect(server.search).toHaveBeenCalledTimes(2);
        c.stop();

        const timed = checker({ server: fakeServerMarketplace([]) as never }, new CliNotificationService());
        const s2 = (timed.c as unknown as { deps: { server: { search: ReturnType<typeof vi.fn> } } }).deps.server;
        timed.c.start();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(s2.search).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(6 * 3_600_000);
        expect(s2.search).toHaveBeenCalledTimes(2);
        timed.c.stop();

        const off = checker({ server: fakeServerMarketplace([]) as never });
        const offChecker = new UpdateChecker((off.c as unknown as { deps: UpdateCheckerDeps }).deps, { enabled: false });
        offChecker.start();
        await vi.advanceTimersByTimeAsync(7 * 3_600_000);
        expect(((offChecker as unknown as { deps: { server: { search: ReturnType<typeof vi.fn> } } }).deps.server.search)).not.toHaveBeenCalled();
    });

    it('updateNotificationKey', () => {
        expect(updateNotificationKey({ kind: 'dashboard', name: TICKETS, package: TICKETS, source: 'marketplace' })).toBe(`update:dashboard:${TICKETS}`);
        expect(updateNotificationKey({ kind: 'server', name: 'weather', package: 'p', source: 'marketplace' })).toBe('update:server:weather');
        expect(updateNotificationKey({ kind: 'dashboard', name: JOBS, package: JOBS, source: 'code' })).toBe(`update:code:dashboard:${JOBS}`);
        expect(updateNotificationKey({ kind: 'core', name: CORE, package: CORE, source: 'npm' })).toBe(`update:core:${CORE}`);
    });
});

describe('GET /api/v1/qcli/updates with the dashboard marketplace', () => {
    it('finds a newer version of an installed dashboard plugin and of a page added in code; Update clears it', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { title: 'Tickets', versions: [{ version: '1.0.0' }] });
        net.publish(JOBS, { title: 'Jobs', versions: [{ version: '1.0.0' }, { version: '1.3.0' }] });
        const h = await start({
            net,
            configure: (cli) => cli.builder.addDashboardExtension({ id: 'jobs', title: 'Jobs', entry: '/qcli/modules/jobs/extension.js', package: JOBS, version: '1.0.0' }),
        });
        await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS }).expect(201);

        // before any check
        expect((await request(h.cli.app).get(UPDATES).set(auth(h.token)).expect(200)).body).toMatchObject({ checkedAt: null, count: 0, dashboardPlugins: [] });

        net.publish(TICKETS, { title: 'Tickets', versions: [{ version: '1.0.0' }, { version: '1.1.0' }] });
        const checked = (await request(h.cli.app).post(`${UPDATES}/check`).set(auth(h.token)).expect(200)).body;
        expect(checked.dashboardPlugins).toEqual([expect.objectContaining({ kind: 'dashboard', name: TICKETS, current: '1.0.0', latest: '1.1.0', source: 'marketplace', canUpdate: true })]);
        expect(checked.codePlugins).toEqual([
            expect.objectContaining({ kind: 'dashboard', name: JOBS, current: '1.0.0', latest: '1.3.0', source: 'code', canUpdate: false, install: { node: `npm install ${JOBS}@1.3.0` } }),
        ]);
        expect(checked.count).toBe(2);
        expect((await request(h.cli.app).get(UPDATES).set(auth(h.token)).expect(200)).body).toMatchObject({ count: 2, checking: false });

        const notes = (await request(h.cli.app).get(`${V1}/notifications`).expect(200)).body.items.map((n: { key: string }) => n.key);
        expect(notes).toEqual(expect.arrayContaining([`update:dashboard:${TICKETS}`, `update:code:dashboard:${JOBS}`]));

        // updated from the dashboard: gone from the list, its notification resolved
        await request(h.cli.app).put(`${BASE}/installed/${encodeURIComponent(TICKETS)}`).set(auth(h.token)).send({}).expect(200);
        expect((await request(h.cli.app).get(UPDATES).set(auth(h.token)).expect(200)).body).toMatchObject({ count: 1, dashboardPlugins: [] });
        expect(h.cli.notifications.get(`update:dashboard:${TICKETS}`)).toBeUndefined();
    });

    it('needs the admin sign-in (password mode)', async () => {
        const h = await start();
        await request(h.cli.app).get(UPDATES).expect(401);
    });

    it('protected server: updates:read or plugins:install', async () => {
        const h = await startProtected({ viewer: ['admin:access'], reader: ['admin:access', 'updates:read'], installer: ['admin:access', 'plugins:install'] });
        await request(h.cli.app).get(UPDATES).set(auth(h.tokens.viewer)).expect(403);
        await request(h.cli.app).post(`${UPDATES}/check`).set(auth(h.tokens.viewer)).expect(403);
        await request(h.cli.app).get(UPDATES).set(auth(h.tokens.reader)).expect(200);
        await request(h.cli.app).get(UPDATES).set(auth(h.tokens.installer)).expect(200);
        await request(h.cli.app).post(`${UPDATES}/check`).set(auth(h.tokens.reader)).expect(200);
        // the update notifications reach only those who may read the updates
        const keys = async (who: string) => (await request(h.cli.app).get(`${V1}/notifications`).set(auth(h.tokens[who])).expect(200)).body.items.map((n: { kind: string }) => n.kind);
        h.cli.notifications.notify({ key: 'update:server:x', kind: 'update', severity: 'info', title: 'Update available: X 2.0.0', message: '', requiredPermission: 'updates:read' });
        expect(await keys('viewer')).not.toContain('update');
        expect(await keys('reader')).toContain('update');
    });
});

describe('jobs scheduler: a job registered after start', () => {
    it('is scheduled at once (the update check registers itself once the server runs)', async () => {
        const { CliJobScheduler } = await import('../../plugins/jobs/cli-job-scheduler');
        const { InMemoryJobStorageProvider } = await import('../../plugins/jobs/in-memory-job-storage-provider');
        vi.useFakeTimers();
        const scheduler = new CliJobScheduler(new InMemoryJobStorageProvider());
        await scheduler.start();
        const run = vi.fn(async () => {});
        scheduler.register({ executeAsync: run }, { id: 'late', name: 'late', interval: '1s' });
        await vi.advanceTimersByTimeAsync(1500);
        expect(run).toHaveBeenCalledTimes(1);
        await scheduler.stop();
    });
});
