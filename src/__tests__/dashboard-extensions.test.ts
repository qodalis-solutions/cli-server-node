/**
 * Dashboard extensions (cli-server-dashboard docs/extensions.md): `builder.addDashboardExtension`,
 * a mounted plugin's `dashboardExtensions`, and `GET /api/v1/qcli/dashboard/extensions`
 * (admin plugin).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Router } from 'express';
import request from 'supertest';
import { CliDashboardExtension, validateDashboardExtension } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliBuilder } from '../extensions/cli-builder';
import { CliCommandRegistry } from '../services';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';
import { CliUsersBuilder } from '../../plugins/users/index';

const V1 = '/api/v1/qcli';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'secret';

const marketplace: CliDashboardExtension = {
    id: 'marketplace',
    title: 'Marketplace',
    titles: { de: 'Marktplatz', 'pt-BR': 'Mercado' },
    icon: '🧩',
    group: 'data',
    order: 10,
    permission: 'marketplace:moderate',
    entry: '/qcli/marketplace/admin/extension.js',
    styles: ['/qcli/marketplace/admin/extension.css'],
    version: '0.1.0',
};

const disposables: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
});

function serverWithAdmin(configure?: (cli: CliServerResult) => void): { cli: CliServerResult; admin: CliAdminPluginResult } {
    const cli = createCliServer();
    configure?.(cli);
    const admin = new CliAdminBuilder()
        .setCredentials(ADMIN_USER, ADMIN_PASS)
        .setJwtSecret('dashboard-extensions-test')
        .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
    cli.mountPlugin(admin);
    disposables.push(() => {
        admin.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return { cli, admin };
}

async function adminToken(cli: CliServerResult): Promise<string> {
    const res = await request(cli.app).post(`${V1}/auth/login`).send({ username: ADMIN_USER, password: ADMIN_PASS });
    return res.body.token;
}

describe('dashboard extensions: registration', () => {
    const builder = () => new CliBuilder(new CliCommandRegistry());

    it('keeps the registration order and only the known fields', () => {
        const b = builder();
        b.addDashboardExtension(marketplace);
        b.addDashboardExtension({ id: 'billing', title: 'Billing', entry: 'https://cdn.example.com/billing.js', extra: 1 } as CliDashboardExtension);
        expect(b.dashboardExtensions).toEqual([marketplace, { id: 'billing', title: 'Billing', entry: 'https://cdn.example.com/billing.js' }]);
    });

    it('refuses an id registered twice', () => {
        const b = builder().addDashboardExtension(marketplace);
        expect(() => b.addDashboardExtension({ ...marketplace, title: 'Again' })).toThrow('dashboard extension already registered: marketplace');
    });

    it('turns an unknown group into system', () => {
        expect(validateDashboardExtension({ id: 'x', title: 'X', entry: '/x.js', group: 'elsewhere' }).group).toBe('system');
    });

    it.each([
        [{ id: 'Bad Id', title: 'X', entry: '/x.js' }, 'id must match'],
        [{ id: '-x', title: 'X', entry: '/x.js' }, 'id must match'],
        [{ id: 'x'.repeat(41), title: 'X', entry: '/x.js' }, 'id must match'],
        [{ id: 'x', title: '', entry: '/x.js' }, 'title must be 1-40 characters'],
        [{ id: 'x', title: 'y'.repeat(41), entry: '/x.js' }, 'title must be 1-40 characters'],
        [{ id: 'x', title: 'X', entry: '//evil.example/x.js' }, 'entry must be'],
        [{ id: 'x', title: 'X', entry: 'javascript:alert(1)' }, 'entry must be'],
        [{ id: 'x', title: 'X', entry: 'x.js' }, 'entry must be'],
        [{ id: 'x', title: 'X', entry: '/x\t.js' }, 'entry must be'],
        [{ id: 'x', title: 'X', entry: '/x.js', titles: { 'not a code': 'X' } }, 'titles must map'],
        [{ id: 'x', title: 'X', entry: '/x.js', icon: '<img>' }, 'icon must be'],
        [{ id: 'x', title: 'X', entry: '/x.js', icon: 'ab' }, 'icon must be'],
        [{ id: 'x', title: 'X', entry: '/x.js', order: 1.5 }, 'order must be an integer'],
        [{ id: 'x', title: 'X', entry: '/x.js', permission: '' }, 'permission must be'],
        [{ id: 'x', title: 'X', entry: '/x.js', styles: ['/a.css', '/b.css', '/c.css', '/d.css', '/e.css', '/f.css'] }, 'styles must be'],
        [{ id: 'x', title: 'X', entry: '/x.js', styles: ['//evil/a.css'] }, 'styles must be'],
        [{ id: 'x', title: 'X', entry: '/x.js', version: '' }, 'version must be'],
    ])('refuses %j', (extension, reason) => {
        expect(() => validateDashboardExtension(extension as CliDashboardExtension)).toThrow(`invalid dashboard extension: `);
        expect(() => validateDashboardExtension(extension as CliDashboardExtension)).toThrow(reason);
    });

    it('accepts emoji made of several code points and image URLs as icons', () => {
        for (const icon of ['🧩', '🇷🇴', '👨‍👩‍👧', '/icons/billing.svg', 'https://cdn.example.com/i.png']) {
            expect(validateDashboardExtension({ id: 'x', title: 'X', entry: '/x.js', icon }).icon).toBe(icon);
        }
    });
});

describe('GET /api/v1/qcli/dashboard/extensions', () => {
    it('lists the extensions of the builder and of mounted plugins, in registration order', async () => {
        const { cli } = serverWithAdmin((c) => {
            c.builder.addDashboardExtension(marketplace);
            c.mountPlugin({
                prefix: '/billing',
                router: Router(),
                cliRoutes: false,
                dashboardExtensions: [{ id: 'billing', title: 'Billing', entry: '/billing/admin.js' }],
            });
        });
        const token = await adminToken(cli);
        const res = await request(cli.app).get(`${V1}/dashboard/extensions`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.body).toEqual({ extensions: [marketplace, { id: 'billing', title: 'Billing', entry: '/billing/admin.js' }] });
    });

    it('answers an empty list when no plugin added a page', async () => {
        const { cli } = serverWithAdmin();
        const token = await adminToken(cli);
        const res = await request(cli.app).get(`${V1}/dashboard/extensions`).set('Authorization', `Bearer ${token}`);
        expect(res.body).toEqual({ extensions: [] });
    });

    it('fails startup for a plugin bringing an invalid or duplicate extension', () => {
        const cli = createCliServer();
        disposables.push(() => {
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        cli.builder.addDashboardExtension(marketplace);
        expect(() => cli.mountPlugin({ prefix: '/m', router: Router(), cliRoutes: false, dashboardExtensions: [marketplace] })).toThrow(
            'dashboard extension already registered: marketplace',
        );
        expect(() => cli.mountPlugin({ prefix: '/n', router: Router(), cliRoutes: false, dashboardExtensions: [{ id: 'n', title: 'N', entry: 'n.js' }] })).toThrow(
            'invalid dashboard extension: n: entry must be',
        );
    });

    it('needs a sign-in, on an open and on a protected server', async () => {
        const open = serverWithAdmin((c) => c.builder.addDashboardExtension(marketplace));
        expect((await request(open.cli.app).get(`${V1}/dashboard/extensions`)).status).toBe(401);

        const cli = createCliServer();
        const users = new CliUsersBuilder().setOptions({ defaultAdminPassword: 'root-pass-123' }).build(cli.eventBus);
        await users.ready;
        cli.mountPlugin(users);
        cli.builder.addDashboardExtension(marketplace);
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
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        expect((await request(cli.app).get(`${V1}/dashboard/extensions`)).status).toBe(401);
        const login = await request(cli.app).post(`${V1}/sessions`).send({ username: 'root', password: 'root-pass-123' });
        const res = await request(cli.app).get(`${V1}/dashboard/extensions`).set('Authorization', `Bearer ${login.body.token}`);
        expect(res.status).toBe(200);
        expect(res.body.extensions.map((e: CliDashboardExtension) => e.id)).toEqual(['marketplace']);
    });
});
