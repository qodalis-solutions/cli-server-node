/**
 * Installed plugins list (`GET /api/v1/qcli/plugins/installed`) and the admin
 * status' `audit` feature (mirrors cli-server-dotnet 1.0.0-beta.15).
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import request from 'supertest';
import {
    CLI_INSTALLED_PLUGIN,
    IDataExplorerProvider,
    installedPluginName,
    installedPluginOf,
    readInstalledPlugin,
} from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliBuilder } from '../extensions/cli-builder';
import { CliCommandRegistry } from '../services';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { InMemoryFileStorageProvider, JsonFileStorageProvider } from '../index';
import { WeatherModule } from '@qodalis/cli-server-plugin-weather';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';

const V1 = '/api/v1/qcli';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'secret';
const ROOT = path.resolve(__dirname, '../..');
const version = (dir: string) => require(path.join(ROOT, dir, 'package.json')).version as string;

const disposables: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
});

function track(cli: CliServerResult, ...plugins: Array<UsersPluginResult | CliAdminPluginResult>): void {
    disposables.push(() => {
        for (const p of plugins) p.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
}

function adminPlugin(cli: CliServerResult): CliAdminPluginResult {
    return new CliAdminBuilder()
        .setCredentials(ADMIN_USER, ADMIN_PASS)
        .setJwtSecret('installed-plugins-test')
        .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
}

async function adminToken(cli: CliServerResult): Promise<string> {
    const res = await request(cli.app).post(`${V1}/auth/login`).send({ username: ADMIN_USER, password: ADMIN_PASS });
    return res.body.token;
}

describe('installed plugins', () => {
    it('lists the core first, then each added plugin package once, in the order added', async () => {
        const cli = createCliServer();
        const admin = adminPlugin(cli);
        // Not protecting the server, so the admin's own sign-in keeps working
        const users = new CliUsersBuilder().setDefaultAdminPassword('rootpass1').setProtectServer(false).build();
        track(cli, admin, users);
        cli.mountPlugin(admin);
        cli.mountPlugin(users);
        cli.mountPlugin(new CliJobsBuilder().build());
        cli.mountPlugin(new CliJobsBuilder().build());

        const res = await request(cli.app).get(`${V1}/plugins/installed`).set('Authorization', `Bearer ${await adminToken(cli)}`);

        expect(res.status).toBe(200);
        expect(res.body.map((p: { id: string }) => p.id)).toEqual([
            '@qodalis/cli-server-node',
            '@qodalis/cli-server-plugin-admin',
            '@qodalis/cli-server-plugin-users',
            '@qodalis/cli-server-plugin-jobs',
        ]);
        expect(res.body[0]).toMatchObject({ name: 'Core', version: version('.') });
        const usersEntry = res.body.find((p: { id: string }) => p.id === '@qodalis/cli-server-plugin-users');
        expect(usersEntry).toMatchObject({ name: 'Users', version: version('plugins/users') });
        expect(usersEntry.description).toContain('User management');
        expect(res.body.find((p: { name: string }) => p.name === 'Admin').version).toBe(version('plugins/admin'));
        expect(res.body.find((p: { name: string }) => p.name === 'Jobs').version).toBe(version('plugins/jobs'));
    });

    it('requires the admin sign-in and is not shadowed by /plugins/:id', async () => {
        const cli = createCliServer();
        const admin = adminPlugin(cli);
        track(cli, admin);
        cli.mountPlugin(admin);

        expect((await request(cli.app).get(`${V1}/plugins/installed`)).status).toBe(401);
        const res = await request(cli.app).get(`${V1}/plugins/installed`).set('Authorization', `Bearer ${await adminToken(cli)}`);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('modules, file storage and data explorer providers list their packages', () => {
        const builder = new CliBuilder(new CliCommandRegistry());
        const provider: IDataExplorerProvider & { [CLI_INSTALLED_PLUGIN]: unknown } = {
            [CLI_INSTALLED_PLUGIN]: { id: '@acme/cli-server-plugin-ledger', name: 'Ledger', version: '2.0.0' },
            executeAsync: async () => ({}) as never,
        };
        const options = { name: 'ledger', description: 'Ledger', language: 'sql', defaultOutputFormat: 'table' } as const;

        builder.addModule(new WeatherModule());
        builder.setFileStorageProvider(new JsonFileStorageProvider({ filePath: path.join(ROOT, 'dist', 'unused-fs.json') }));
        builder.setFileStorageProvider(new InMemoryFileStorageProvider());
        builder.addDataExplorerProvider(() => provider, options);
        builder.addDataExplorerProvider(provider, { ...options, name: 'ledger2' });

        expect(builder.installedPlugins.map((p) => [p.id, p.name])).toEqual([
            ['@qodalis/cli-server-node', 'Core'],
            ['@qodalis/cli-server-plugin-weather', 'Weather'],
            ['@qodalis/cli-server-plugin-filesystem', 'FileSystem'],
            ['@qodalis/cli-server-plugin-filesystem-json', 'FileSystem.Json'],
            ['@qodalis/cli-server-plugin-data-explorer', 'DataExplorer'],
            ['@acme/cli-server-plugin-ledger', 'Ledger'],
        ]);
        expect(builder.installedPlugins[1].version).toBe(version('plugins/weather'));
    });

    it('a plugin of the host lists itself by description or by a directory inside its package', () => {
        const builder = new CliBuilder(new CliCommandRegistry());

        builder.addInstalledPlugin({ id: '@acme/billing', name: 'Billing', version: '1.2.3' });
        builder.addInstalledPlugin(path.join(ROOT, 'plugins', 'filesystem-s3'));
        builder.addInstalledPlugin({ id: '@acme/billing', name: 'Billing again' });

        expect(builder.installedPlugins.slice(1)).toEqual([
            { id: '@acme/billing', name: 'Billing', version: '1.2.3' },
            expect.objectContaining({ id: '@qodalis/cli-server-plugin-filesystem-s3', name: 'Filesystem.S3', version: version('plugins/filesystem-s3') }),
        ]);
    });

    it('reads a package from a directory inside it and names it', () => {
        expect(readInstalledPlugin(path.join(ROOT, 'plugins', 'jobs', 'dist'), '@qodalis/cli-server-plugin-jobs', 'Jobs')).toMatchObject({
            id: '@qodalis/cli-server-plugin-jobs',
            name: 'Jobs',
            version: version('plugins/jobs'),
        });
        expect(readInstalledPlugin(ROOT, '@nobody/nothing')).toBeUndefined();
        expect(installedPluginName('@acme/cli-server-plugin-billing-sync')).toBe('Billing.Sync');
        expect(installedPluginName('my-plugin')).toBe('My.Plugin');
        expect(installedPluginOf({})).toBeUndefined();
        expect(installedPluginOf(new InMemoryFileStorageProvider())?.name).toBe('FileSystem');
    });
});

describe('admin status: audit feature', () => {
    it('reports "audit" after filesystem and jobs when the users plugin is installed', async () => {
        const cli = createCliServer({ configure: (b) => b.setFileStorageProvider(new InMemoryFileStorageProvider()) });
        const admin = adminPlugin(cli);
        track(cli, admin);
        cli.mountPlugin(admin);
        cli.mountPlugin(new CliJobsBuilder().build());
        const status = async () =>
            (await request(cli.app).get(`${V1}/status`).set('Authorization', `Bearer ${await adminToken(cli)}`)).body.enabledFeatures;

        expect(await status()).toEqual(['filesystem', 'jobs']);

        // Installed without protecting the server, so the admin sign-in keeps working
        const users = new CliUsersBuilder().setDefaultAdminPassword('rootpass1').build();
        disposables.push(() => users.dispose());
        cli.builder.addInstalledPlugin(users.installedPlugin);
        expect(await status()).toEqual(['filesystem', 'jobs', 'audit']);
    });
});
