/**
 * GET /commands lists each command's own requiredPermissions, sub-commands included (the parents' and
 * commands:execute are not repeated); a command without any has no requiredPermissions field.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { AwsModule } from '@qodalis/cli-server-plugin-aws';
import { CliDatabasesBuilder, sqliteConnection } from '@qodalis/cli-server-plugin-databases';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliServerCommandDescriptor } from '../models';
import { CliHttpCommandProcessor } from '../processors';
import { CliAdminBuilder } from '../../plugins/admin/index';
import { DemoModule } from '../../demo/src/demo-module';

const disposables: Array<() => void> = [];
afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

function start(): CliServerResult {
    const db = new Database(':memory:');
    const cli = createCliServer({
        configure: (b) => b.addModule(new AwsModule()).addModule(new DemoModule()).addProcessor(new CliHttpCommandProcessor()),
    });
    cli.mountPlugin(new CliDatabasesBuilder().addDatabase('main', { connection: sqliteConnection(db) }).setDashboardDir(false).build());
    const admin = new CliAdminBuilder().setCredentials('admin', 'pass').setJwtSecret('secret').build({
        registry: cli.registry,
        eventSocketManager: cli.eventSocketManager,
        builder: cli.builder,
        executor: cli.executor,
        broadcastFn: () => {},
    });
    admin.logBuffer.restoreConsole();
    admin.statusSampler.stop();
    cli.mountPlugin(admin);
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
        db.close();
    });
    return cli;
}

async function commands(cli: CliServerResult): Promise<CliServerCommandDescriptor[]> {
    const res = await request(cli.app).get('/api/v1/qcli/commands');
    expect(res.status).toBe(200);
    return res.body;
}

/** The descriptor at a command path, e.g. `['aws', 's3', 'rm']`. */
function at(list: CliServerCommandDescriptor[], path: string[]): CliServerCommandDescriptor {
    let current: CliServerCommandDescriptor | undefined;
    let level: CliServerCommandDescriptor[] | undefined = list;
    for (const name of path) {
        current = level?.find((c) => c.command === name);
        expect(current, path.join(' ')).toBeDefined();
        level = current!.processors;
    }
    return current!;
}

describe('GET /commands: requiredPermissions', () => {
    it("lists the root commands' own permissions", async () => {
        const list = await commands(start());

        expect(at(list, ['aws']).requiredPermissions).toEqual(['aws:read']);
        expect(at(list, ['databases']).requiredPermissions).toEqual(['databases:read']);
        expect(at(list, ['http']).requiredPermissions).toEqual(['http:request']);
        expect(at(list, ['admin']).requiredPermissions).toEqual(['admin:access']);
    });

    it("lists a sub-command's own permissions, without the parents' or commands:execute", async () => {
        const list = await commands(start());

        expect(at(list, ['aws', 's3', 'rm']).requiredPermissions).toEqual(['aws:write']);
        expect(at(list, ['aws', 'configure', 'set']).requiredPermissions).toEqual(['aws:write']);
        expect(at(list, ['databases', 'up']).requiredPermissions).toEqual(['databases:migrate']);
        expect(at(list, ['admin', 'logs']).requiredPermissions).toEqual(['logs:read']);
        // read-only sub-commands declare nothing of their own: aws:read comes from the root and is not repeated
        expect(at(list, ['aws', 's3', 'ls'])).not.toHaveProperty('requiredPermissions');
        expect(at(list, ['admin', 'status'])).not.toHaveProperty('requiredPermissions');
    });

    it('leaves the field out for a command without permissions', async () => {
        const list = await commands(start());

        expect(at(list, ['echo'])).not.toHaveProperty('requiredPermissions');
        expect(JSON.stringify(list)).not.toContain('commands:execute');
    });
});
