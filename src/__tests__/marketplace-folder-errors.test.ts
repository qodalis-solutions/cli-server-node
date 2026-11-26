/**
 * The marketplace's plugins folders: dashboard plugins default to `<dataDir>/dashboard-plugins` (dataDir from the
 * option, else QCLI_DATA_DIR), a file system failure while installing, updating or removing a dashboard or server
 * plugin answers 500 naming the folder and what to set (the commands print it), and a startup WARNING names a folder
 * that cannot be created or written.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createCliServer } from '../create-cli-server';
import { CliAdminBuilder } from '../../plugins/admin/index';
import { pluginsFolderError, unwritableFolderCode, unwritableFoldersWarning } from '../../plugins/admin/services/plugins-folder';
import { runCommand, V1 } from './command-test-helpers';
import { BASE, FakeNet, MARKET, TICKETS, auth, cleanupMarketplaceHosts, start, trackHost } from './dashboard-marketplace-test-helpers';
import { FakeServerNet, SBASE, bearer, cleanupServerHosts, startServer } from './server-marketplace-test-helpers';

const locked: string[] = [];
const temps: string[] = [];

function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'qcli-folder-errors-'));
    temps.push(dir);
    return dir;
}

/** Makes a folder (and what is in it) read-only until the test ends. */
function lock(dir: string): void {
    chmodSync(dir, 0o555);
    locked.push(dir);
}

const root = process.getuid?.() === 0;

afterEach(() => {
    for (const d of locked.splice(0)) chmodSync(d, 0o755);
    cleanupMarketplaceHosts();
    cleanupServerHosts();
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.QCLI_DATA_DIR;
    vi.restoreAllMocks();
});

const DATA_HINT = 'Set dataDir (or QCLI_DATA_DIR) to a writable folder';

/** A server whose admin plugin keeps dashboard plugins in its data directory (no `dir`). */
async function startInDataDir(net: FakeNet, dataDir?: string) {
    const cli = createCliServer({ allowAnonymousAdmin: true, ...(dataDir ? { dataDir } : {}) });
    const admin = new CliAdminBuilder()
        .setCredentials('admin', 'pass')
        .setJwtSecret('folder-test')
        .setMarketplace({ url: MARKET, fetch: net.fetch })
        .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, executor: cli.executor, broadcastFn: () => {} });
    admin.logBuffer.restoreConsole();
    admin.statusSampler.stop();
    cli.mountPlugin(admin);
    const token = (await request(cli.app).post(`${V1}/auth/login`).send({ username: 'admin', password: 'pass' })).body.token as string;
    trackHost({ cli, admin, dir: '', net, audit: [], events: [], token } as never);
    return { cli, admin, token };
}

describe('plugins folder: helpers', () => {
    it('names the folder, the reason and the hint only for file system errors on the folder or its parents', () => {
        const folder = resolve('/srv/app/qcli-data/dashboard-plugins');
        const fsError = (path: string, code = 'EACCES', syscall = 'mkdir') => Object.assign(new Error(`${code}: secret text, ${syscall} '${path}'`), { code, syscall, path });
        const message = `cannot write the plugins folder ${folder}: permission denied (EACCES). ${DATA_HINT}`;
        expect(pluginsFolderError(fsError('/srv/app/qcli-data'), folder, DATA_HINT)).toBe(message);
        expect(pluginsFolderError(fsError(join(folder, 'installed.json.tmp'), 'EACCES', 'open'), folder, DATA_HINT)).toBe(message);
        expect(pluginsFolderError(fsError(folder, 'EROFS'), folder, DATA_HINT)).toBe(`cannot write the plugins folder ${folder}: read-only file system (EROFS). ${DATA_HINT}`);
        expect(pluginsFolderError(fsError(folder, 'ENOSPC', 'write'), folder, DATA_HINT)).toContain('no space left on device (ENOSPC)');
        // not about the folder: another path, a missing program, a network error, a plain error
        expect(pluginsFolderError(fsError('/etc/other'), folder, DATA_HINT)).toBeUndefined();
        expect(pluginsFolderError(fsError(folder, 'ENOENT', 'spawn npm'), folder, DATA_HINT)).toBeUndefined();
        expect(pluginsFolderError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), folder, DATA_HINT)).toBeUndefined();
        expect(pluginsFolderError(new Error('boom'), folder, DATA_HINT)).toBeUndefined();
    });

    it.skipIf(root)('finds a folder that cannot be created or written, without creating it', () => {
        const dir = temp();
        expect(unwritableFolderCode(join(dir, 'a', 'b'))).toBeUndefined();
        expect(existsSync(join(dir, 'a'))).toBe(false);
        lock(dir);
        expect(unwritableFolderCode(join(dir, 'a', 'b'))).toBe('EACCES');
        expect(unwritableFolderCode(dir)).toBe('EACCES');
        expect(unwritableFoldersWarning([{ dir: join(dir, 'x'), hint: DATA_HINT }])).toBe(
            `[qcli-admin] WARNING: the marketplace cannot write the plugins folder ${join(dir, 'x')}: permission denied (EACCES). Installing, updating and removing plugins will fail. ${DATA_HINT}.`,
        );
        expect(unwritableFoldersWarning([])).toBeUndefined();
    });
});

describe('plugins folder: the data directory', () => {
    it('keeps dashboard plugins in <dataDir>/dashboard-plugins', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { title: 'Tickets', versions: [{ version: '1.0.0' }] });
        const dataDir = temp();
        const h = await startInDataDir(net, dataDir);
        expect((await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS })).status).toBe(201);
        expect(existsSync(join(dataDir, 'dashboard-plugins', 'installed.json'))).toBe(true);
    });

    it('reads QCLI_DATA_DIR when dataDir is not given; dataDir and an explicit dir win', async () => {
        const fromEnv = temp();
        process.env.QCLI_DATA_DIR = fromEnv;
        const net = new FakeNet();
        net.publish(TICKETS, { title: 'Tickets', versions: [{ version: '1.0.0' }] });
        const h = await startInDataDir(net);
        expect(h.cli.builder.serverPlugins.dataDir).toBe(resolve(fromEnv));
        expect(h.cli.builder.serverPlugins.dir).toBe(join(resolve(fromEnv), 'server-plugins'));
        expect((await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS })).status).toBe(201);
        expect(existsSync(join(fromEnv, 'dashboard-plugins', 'installed.json'))).toBe(true);

        const own = temp();
        expect(createCliServer({ dataDir: own }).builder.serverPlugins.dataDir).toBe(resolve(own));
        const explicit = join(temp(), 'mine');
        const e = await start({ net, dir: explicit });
        expect((await request(e.cli.app).post(`${BASE}/installed`).set(auth(e.token)).send({ name: TICKETS })).status).toBe(201);
        expect(existsSync(join(explicit, 'installed.json'))).toBe(true);
    });
});

describe.skipIf(root)('plugins folder: clear errors', () => {
    it('dashboard plugins: install, update and remove answer 500 naming the folder (default: set dataDir)', async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { title: 'Tickets', versions: [{ version: '1.0.0' }, { version: '1.1.0' }] });
        const parent = temp();
        const dataDir = join(parent, 'qcli-data');
        const h = await startInDataDir(net, dataDir);
        const folder = join(dataDir, 'dashboard-plugins');
        const expected = { error: `cannot write the plugins folder ${folder}: permission denied (EACCES). ${DATA_HINT}` };

        lock(parent);
        const install = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS, version: '1.0.0' });
        expect(install.status).toBe(500);
        expect(install.body).toEqual(expected);
        expect((await runCommand(h.cli, `admin dashboard install ${TICKETS}@1.0.0`)).text).toBe(`Error: ${expected.error}`);

        // installed while writable, then the folder turns read-only
        chmodSync(parent, 0o755);
        expect((await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS, version: '1.0.0' })).status).toBe(201);
        lock(folder);
        const update = await request(h.cli.app).put(`${BASE}/installed/${encodeURIComponent(TICKETS)}`).set(auth(h.token)).send({});
        expect(update.status).toBe(500);
        expect(update.body).toEqual(expected);
        const remove = await request(h.cli.app).delete(`${BASE}/installed/${encodeURIComponent(TICKETS)}`).set(auth(h.token));
        expect(remove.status).toBe(500);
        expect(remove.body).toEqual(expected);
    });

    it("dashboard plugins: an explicit dir names the marketplace's dir", async () => {
        const net = new FakeNet();
        net.publish(TICKETS, { title: 'Tickets', versions: [{ version: '1.0.0' }] });
        const parent = temp();
        const dir = join(parent, 'plugins');
        const h = await start({ net, dir });
        lock(parent);
        const res = await request(h.cli.app).post(`${BASE}/installed`).set(auth(h.token)).send({ name: TICKETS });
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: `cannot write the plugins folder ${dir}: permission denied (EACCES). Set the marketplace's dir to a writable folder` });
    });

    it('server plugins: install answers 500 naming the folder; admin plugins install prints it', async () => {
        const net = new FakeServerNet();
        net.publish('weather', { icon: '🌤️', versions: [{ version: '1.0.0' }] });
        const dataDir = temp();
        const h = await startServer({ net, dataDir });
        lock(dataDir);
        const expected = `cannot write the plugins folder ${join(dataDir, 'server-plugins')}: permission denied (EACCES). ${DATA_HINT}`;
        const res = await request(h.cli.app).post(`${SBASE}/installed`).set(bearer(h.token)).send({ name: 'weather' });
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: expected });
        expect((await runCommand(h.cli, 'admin plugins install weather')).text).toBe(`Error: ${expected}`);
    });

    it('logs one WARNING at startup when a marketplace folder cannot be written, none when it can', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const parent = temp();
        await startInDataDir(new FakeNet(), join(parent, 'qcli-data'));
        expect(warn.mock.calls.filter(([m]) => String(m).includes('plugins folder'))).toEqual([]);

        lock(parent);
        await startInDataDir(new FakeNet(), join(parent, 'qcli-data'));
        const lines = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('plugins folder'));
        expect(lines).toEqual([
            `[qcli-admin] WARNING: the marketplace cannot write the plugins folders ${join(parent, 'qcli-data', 'dashboard-plugins')}: permission denied (EACCES); ${join(parent, 'qcli-data', 'server-plugins')}: permission denied (EACCES). Installing, updating and removing plugins will fail. ${DATA_HINT}.`,
        ]);
    });
});
