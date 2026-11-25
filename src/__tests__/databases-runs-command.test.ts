/**
 * `databases runs [<db>] [-n N] [--json]`: the migration run history through POST /execute, empty history, several
 * databases, bad limits, unknown databases, and databases:read on a protected server.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CliDatabasesBuilder, sqliteConnection, type CliMigration } from '@qodalis/cli-server-plugin-databases';
import { createCliServer } from '../create-cli-server';
import { formatRunLine } from '../../plugins/databases/commands';
import { protect, runCommand, subPermissions } from './command-test-helpers';

const migrations: CliMigration[] = [
    { id: '1', name: 'create notes', up: 'CREATE TABLE "Notes" ("Id" INTEGER PRIMARY KEY)', down: 'DROP TABLE "Notes"' },
    { id: '2', name: 'create tags', up: 'CREATE TABLE "Tags" ("Id" INTEGER PRIMARY KEY)', down: 'DROP TABLE "Tags"' },
    { id: '3', name: 'broken', up: 'CREATE TABLE "Tags" ("Id" INTEGER PRIMARY KEY)', down: 'SELECT 1' },
];

const disposables: Array<() => void> = [];
afterEach(() => {
    vi.useRealTimers();
    for (const dispose of disposables.splice(0)) dispose();
});

function server(names = ['main']) {
    const cli = createCliServer();
    const builder = new CliDatabasesBuilder();
    for (const name of names) {
        const db = new Database(':memory:');
        builder.addDatabase(name, { connection: sqliteConnection(db) }).addMigrations(name, 'app', migrations);
        disposables.push(() => db.close());
    }
    const plugin = builder.build();
    cli.mountPlugin(plugin);
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return { cli, plugin };
}

describe('databases runs', () => {
    it('is a sub-command of databases needing databases:read', () => {
        const { cli } = server();
        expect(subPermissions(cli, 'databases').runs).toEqual(['databases:read']);
    });

    it('says so when nothing ran yet', async () => {
        const { cli } = server();
        expect((await runCommand(cli, 'databases runs')).text).toBe('main: no migration runs yet');
        const json = JSON.parse((await runCommand(cli, 'databases runs main --json')).text);
        expect(json).toEqual({ database: 'main', items: [], total: 0 });
    });

    it('lists the runs newest first with direction, status, count, trigger and actor, and the error of a failed one', async () => {
        const { cli, plugin } = server();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
        await plugin.databases.run('main', 'up', { to: '2', trigger: 'terminal', actor: 'alice' });
        vi.setSystemTime(new Date('2026-11-25T10:05:00Z'));
        await plugin.databases.run('main', 'up', { trigger: 'api' });
        const { text, exitCode } = await runCommand(cli, 'databases runs main');
        expect(exitCode).toBe(0);
        const lines = text.split('\n');
        expect(lines[0]).toBe('main (sqlite): 2 of 2 run(s)');
        expect(lines[1]).toMatch(/^Started\s+Dir\s+Status\s+Count\s+Trigger$/);
        expect(lines[2]).toMatch(/^2026-11-25 10:05:00 up\s+failed\s+0\s+api\s+.*already exists/);
        expect(lines[3]).toMatch(/up\s+succeeded\s+2\s+terminal \(alice\)\s+to 2$/);
    });

    it('-n / --limit caps the list and reports the total; --json prints the payload', async () => {
        const { cli, plugin } = server();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
        await plugin.databases.run('main', 'up', { to: '1' });
        vi.setSystemTime(new Date('2026-11-25T10:01:00Z'));
        await plugin.databases.run('main', 'up', { to: '2' });
        vi.setSystemTime(new Date('2026-11-25T10:02:00Z'));
        await plugin.databases.run('main', 'down', { to: 'base' });
        expect((await runCommand(cli, 'databases runs -n 1')).text.split('\n')[0]).toBe('main (sqlite): 1 of 3 run(s)');
        expect((await runCommand(cli, 'databases runs --limit 2')).text.split('\n')).toHaveLength(4);
        const json = JSON.parse((await runCommand(cli, 'databases runs main -n 2 --json')).text);
        expect(json.total).toBe(3);
        expect(json.items).toHaveLength(2);
        expect(json.items[0]).toMatchObject({ direction: 'down', status: 'succeeded', target: 'base' });
    });

    it('refuses a bad limit', async () => {
        const { cli } = server();
        for (const bad of ['0', '101', 'abc', '2.5', '-3']) {
            expect((await runCommand(cli, `databases runs main --limit ${bad}`)).text).toBe('Error: --limit must be a whole number from 1 to 100');
        }
    });

    it('needs the database when there are several, and refuses an unknown one', async () => {
        const { cli } = server(['main', 'logs']);
        expect((await runCommand(cli, 'databases runs')).text).toBe('Error: name the database: main, logs');
        expect((await runCommand(cli, 'databases runs nope')).text).toBe('Error: unknown database: nope');
        expect((await runCommand(cli, 'databases runs logs')).text).toBe('logs: no migration runs yet');
    });

    it('formats a run without an actor, target or error', () => {
        const line = formatRunLine({ id: '1', direction: 'down', trigger: 'startup', startedAt: '2026-11-25T10:04:05.123Z', status: 'running', applied: [] });
        expect(line).toBe('2026-11-25 10:04:05 down running       0 startup');
    });

    it('on a protected server needs databases:read', async () => {
        const { cli } = server();
        const { plugin, tokens } = await protect(cli, { runner: ['commands:execute'], reader: ['commands:execute', 'databases:read'] });
        disposables.push(() => plugin.dispose());
        expect((await runCommand(cli, 'databases runs')).status).toBe(401);
        const denied = await runCommand(cli, 'databases runs', tokens.runner);
        expect(denied.status).toBe(403);
        expect(denied.body.error).toContain('databases:read');
        expect((await runCommand(cli, 'databases runs', tokens.reader)).text).toBe('main: no migration runs yet');
    });
});
