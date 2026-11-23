/**
 * The migrations plugin on a server: API, route permissions, terminal commands, the run event, the audit entry and
 * the startup apply (SQLite).
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { CliMigrationsBuilder, sqliteConnection, type CliMigration } from '@qodalis/cli-server-plugin-migrations';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, InMemoryAuditStore } from '../../plugins/users/index';

const API = '/api/v1/qcli/migrations';

const migrations: CliMigration[] = [
    { id: '1', name: 'create notes', up: 'CREATE TABLE "Notes" ("Id" INTEGER PRIMARY KEY)', down: 'DROP TABLE "Notes"' },
    { id: '2', name: 'create tags', up: 'CREATE TABLE "Tags" ("Id" INTEGER PRIMARY KEY)', down: 'DROP TABLE "Tags"' },
];

const disposables: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
});

function server(options: { applyOnStartup?: boolean; list?: CliMigration[]; mcp?: boolean } = {}) {
    const db = new Database(':memory:');
    const cli = createCliServer(options.mcp ? { mcp: true } : {});
    const audit = new InMemoryAuditStore();
    const plugin = new CliMigrationsBuilder()
        .addDatabase('main', { connection: sqliteConnection(db), applyOnStartup: options.applyOnStartup })
        .addMigrations('main', 'app', options.list ?? migrations)
        .setAuditStore(audit)
        .build();
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
        db.close();
    });
    return { cli, plugin, audit, db };
}

/** Runs `migrations <sub> <value> --args` as the web terminal sends it (already parsed). */
async function execute(cli: CliServerResult, line: string) {
    const words = line.split(/\s+/).slice(1);
    const chainCommands: string[] = [];
    const args: Record<string, unknown> = {};
    const positionals: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w.startsWith('--')) {
            const next = words[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                args[w.slice(2)] = next;
                i++;
            } else {
                args[w.slice(2)] = true;
            }
        } else if (positionals.length === 0 && ['status', 'up', 'down'].includes(w) && chainCommands.length === 0) {
            chainCommands.push(w);
        } else {
            positionals.push(w);
        }
    }
    const res = await request(cli.app)
        .post('/api/v1/qcli/execute')
        .send({ command: 'migrations', chainCommands, value: positionals.join(' ') || undefined, positionals, args, rawCommand: line });
    return JSON.stringify(res.body);
}

describe('migrations plugin', () => {
    it('lists, shows, runs and rolls back through the API, publishing the run and auditing it', async () => {
        const { cli, plugin, audit } = server();
        const events: Array<{ type: string; data: Record<string, unknown> }> = [];
        cli.eventBus.subscribe('migrations:*', (e) => void events.push({ type: e.type, data: e.data }));
        cli.mountPlugin(plugin);

        const overview = await request(cli.app).get(API);
        expect(overview.body).toEqual({ databases: [{ name: 'main', dialect: 'sqlite', sources: ['app'], applied: 0, pending: 2, problems: 0 }] });

        const detail = await request(cli.app).get(`${API}/main`);
        expect(detail.body.migrations.map((m: { id: string; status: string }) => `${m.id}:${m.status}`)).toEqual(['1:pending', '2:pending']);

        const sql = await request(cli.app).get(`${API}/main/sql`).query({ to: '1' });
        expect(sql.body.sql).toContain('CREATE TABLE "Notes"');
        expect(sql.body.sql).not.toContain('"Tags"');

        const up = await request(cli.app).post(`${API}/main/up`).send({});
        expect(up.status).toBe(200);
        expect(up.body).toMatchObject({ direction: 'up', status: 'succeeded', trigger: 'api' });
        expect(up.body.applied.map((a: { id: string }) => a.id)).toEqual(['1', '2']);
        expect(events).toEqual([{ type: 'migrations:run', data: expect.objectContaining({ database: 'main', direction: 'up', status: 'succeeded', count: 2 }) }]);
        const entries = await audit.getEntries();
        expect(entries[0]).toMatchObject({ event: 'migrations.up', target: 'database:main', details: 'app:1, app:2' });

        const down = await request(cli.app).post(`${API}/main/down`).send({ to: '1' });
        expect(down.body.applied.map((a: { id: string }) => a.id)).toEqual(['2']);
        expect((await request(cli.app).post(`${API}/main/down`).send({})).body).toEqual({
            error: 'to is required to roll back (an id, or base for everything)',
        });

        const runs = await request(cli.app).get(`${API}/main/runs`);
        expect(runs.body.total).toBe(2);
        expect(runs.body.items[0].direction).toBe('down');
        expect((await request(cli.app).get(`${API}/nope`)).status).toBe(404);
        expect((await request(cli.app).post(`${API}/main/up`).send({ to: 'x'.repeat(300) })).status).toBe(400);
    });

    it('brings its commands, its permissions and its installed-plugin entry', async () => {
        const { cli, plugin } = server();
        cli.mountPlugin(plugin);
        expect(cli.builder.permissions.all().map((p) => p.name)).toEqual(expect.arrayContaining(['migrations:read', 'migrations:run']));
        expect(cli.builder.installedPlugins.map((p) => p.id)).toContain('@qodalis/cli-server-plugin-migrations');

        expect(await execute(cli, 'migrations')).toContain('main (sqlite): 0 applied, 2 pending');
        expect(await execute(cli, 'migrations up --dry-run')).toContain('CREATE TABLE');
        expect(await execute(cli, 'migrations up main --to 1')).toContain('Applied 1 migration(s) (succeeded)');
        expect(await execute(cli, 'migrations status main')).toMatch(/applied\s+app:1\s+create notes/);
        expect(await execute(cli, 'migrations down main')).toContain('--to is required');
        expect(await execute(cli, 'migrations down main --to base')).toContain('Rolled back 1 migration(s)');
    });

    it('on a protected server, reading needs migrations:read and running migrations:run', async () => {
        const { cli, plugin } = server();
        const users = new CliUsersBuilder().setOptions({ defaultAdminPassword: 'root-pass-123' }).build(cli.eventBus);
        await users.ready;
        cli.mountPlugin(users);
        cli.mountPlugin(plugin);
        disposables.push(() => users.dispose());
        await users.groupStore.createGroup({ name: 'viewers', permissions: ['migrations:read'] });
        await users.userStore.createUser({ name: 'viewer', email: 'v@example.com', groups: ['viewers'] });
        await users.authService.setPassword((await users.userStore.getUser('viewer'))!.id, 'viewer-pass-123');
        const login = async (username: string, password: string) =>
            (await request(cli.app).post('/api/v1/qcli/sessions').send({ username, password })).body.token as string;
        const viewer = await login('viewer', 'viewer-pass-123');
        const root = await login('root', 'root-pass-123');

        expect((await request(cli.app).get(API)).status).toBe(401);
        expect((await request(cli.app).get(API).set('Authorization', `Bearer ${viewer}`)).status).toBe(200);
        expect((await request(cli.app).post(`${API}/main/up`).set('Authorization', `Bearer ${viewer}`).send({})).status).toBe(403);
        const up = await request(cli.app).post(`${API}/main/up`).set('Authorization', `Bearer ${root}`).send({});
        expect(up.body).toMatchObject({ status: 'succeeded', actor: 'root' });
    });

    it('applies on startup and stops with the failing migration', async () => {
        const ok = server({ applyOnStartup: true });
        const runs = await ok.plugin.applyOnStartup();
        expect(runs.map((r) => [r.trigger, r.applied.length])).toEqual([['startup', 2]]);

        const bad = server({ applyOnStartup: true, list: [{ id: '1', name: 'broken', up: 'CREATE TABLE' }] });
        await expect(bad.plugin.applyOnStartup()).rejects.toThrow(/migrations of main failed: app:1 broken: /);
    });

    it('serves the migrations_* MCP tools', async () => {
        const { cli, plugin } = server({ mcp: true });
        cli.mountPlugin(plugin);
        let id = 1;
        const call = async (name: string, args: Record<string, unknown> = {}) =>
            (
                await request(cli.app)
                    .post('/api/qcli/mcp')
                    .set('Accept', 'application/json, text/event-stream')
                    .send({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })
            ).body.result as { content: Array<{ text: string }>; structuredContent?: Record<string, any>; isError?: boolean };

        const tools = (await request(cli.app).post('/api/qcli/mcp').set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: id++, method: 'tools/list' })).body.result.tools;
        expect(tools.map((t: { name: string }) => t.name)).toEqual(
            expect.arrayContaining(['migrations_status', 'migrations_runs', 'migrations_sql', 'migrations_up', 'migrations_down']),
        );

        expect((await call('migrations_status')).content[0].text).toBe('main (sqlite): 0 applied, 2 pending');
        expect((await call('migrations_sql', { database: 'main', to: '1' })).content[0].text).toContain('CREATE TABLE "Notes"');
        const up = await call('migrations_up', { database: 'main' });
        expect(up.content[0].text).toBe('Applied 2 migration(s) (succeeded)');
        expect(up.structuredContent).toMatchObject({ trigger: 'mcp', status: 'succeeded' });
        expect((await call('migrations_status', { database: 'main' })).content[0].text).toMatch(/applied\s+app:2 create tags/);
        expect((await call('migrations_down', { database: 'main', to: 'base' })).content[0].text).toBe('Rolled back 2 migration(s) (succeeded)');
        expect((await call('migrations_runs', { database: 'main' })).structuredContent).toMatchObject({ total: 2 });
        const unknown = await call('migrations_status', { database: 'nope' });
        expect(unknown).toMatchObject({ isError: true, content: [{ text: 'unknown database: nope' }] });
    });
});
