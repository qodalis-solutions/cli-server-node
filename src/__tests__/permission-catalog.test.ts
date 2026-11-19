/**
 * Permission catalog (core): the permissions core, plugins and the host register
 * (`builder.permissions`, `builder.addPermissions`).
 */
import { describe, it, expect } from 'vitest';
import { createCliServer } from '../create-cli-server';
import { CliPermissionCatalog, CORE_PERMISSIONS } from '../permissions/cli-permission-catalog';
import type { ICliServerAuth } from '../auth/cli-server-auth';

const CORE_NAMES = [
    'commands:execute',
    'shell:execute',
    'files:read',
    'files:write',
    'data:query',
    'jobs:read',
    'jobs:manage',
    'logs:read',
    'admin:access',
    'audit:read',
    'audit:clear',
];

describe('permission catalog', () => {
    it('seeds the core permissions', () => {
        const { builder } = createCliServer({});
        const all = builder.permissions.all();
        expect(all.map((p) => p.name)).toEqual(CORE_NAMES);
        expect(all.every((p) => p.surface === 'cli')).toBe(true);
        expect(CORE_PERMISSIONS.map((p) => p.name)).toEqual(CORE_NAMES);
        const files = builder.permissions.find('FILES:READ');
        expect(files).toEqual({ name: 'files:read', description: 'List, read and download files', group: 'Files', surface: 'cli' });
    });

    it('addPermissions adds host entries', () => {
        const { builder } = createCliServer({});
        const result = builder.addPermissions([{ name: 'rates:read', description: 'Official exchange rates', group: 'Rates' }]);
        expect(result).toBe(builder);
        const all = builder.permissions.all();
        expect(all[all.length - 1]).toEqual({ name: 'rates:read', description: 'Official exchange rates', group: 'Rates', surface: 'host' });

        builder.addPermissions([{ name: 'plugin:run', description: 'Run the plugin', group: 'Plugin' }], 'cli');
        expect(builder.permissions.find('plugin:run')?.surface).toBe('cli');
    });

    it('all() returns copies', () => {
        const catalog = new CliPermissionCatalog();
        catalog.add([{ name: 'a:b', description: 'A', group: 'G' }], 'host');
        catalog.all()[0].description = 'changed';
        expect(catalog.find('a:b')?.description).toBe('A');
        expect(new CliPermissionCatalog().all()).toEqual([]);
    });

    it('rejects invalid entries', () => {
        const catalog = new CliPermissionCatalog();
        const cases = [
            { name: 'rates', description: 'd', group: 'g' },
            { name: 'rates:*', description: 'd', group: 'g' },
            { name: '*', description: 'd', group: 'g' },
            { name: 'Rates:Read', description: 'd', group: 'g' },
            { name: 'a:b:c', description: 'd', group: 'g' },
            { name: '', description: 'd', group: 'g' },
            { name: 'rates:read', description: '', group: 'g' },
            { name: 'rates:read', description: 'x'.repeat(201), group: 'g' },
            { name: 'rates:read', description: 'two\nlines', group: 'g' },
            { name: 'rates:read', description: 'd', group: '' },
            { name: 'rates:read', description: 'd', group: 'x'.repeat(65) },
        ];
        for (const entry of cases) {
            expect(() => catalog.add([entry], 'host'), JSON.stringify(entry)).toThrow(`invalid permission entry: ${entry.name}`);
        }
        expect(() => catalog.add([{ name: 'rates:read', description: 'x'.repeat(200), group: 'x'.repeat(64) }], 'host')).not.toThrow();
        expect(() => catalog.add([{ name: 'x:y', description: 'd', group: 'g' }], 'other' as any)).toThrow('invalid permission entry: x:y');
    });

    it('rejects duplicates', () => {
        const { builder } = createCliServer({});
        expect(() => builder.addPermissions([{ name: 'files:read', description: 'd', group: 'g' }])).toThrow(
            'permission already registered: files:read',
        );
        expect(() => builder.addPermissions([{ name: 'FILES:READ', description: 'd', group: 'g' }])).toThrow(
            'permission already registered: FILES:READ',
        );
        const catalog = new CliPermissionCatalog();
        expect(() =>
            catalog.add(
                [
                    { name: 'a:b', description: 'd', group: 'g' },
                    { name: 'a:b', description: 'd', group: 'g' },
                ],
                'cli',
            ),
        ).toThrow('permission already registered: a:b');
    });

    it('hands the catalog to the auth provider', () => {
        const cli = createCliServer({});
        let arg: any;
        const auth: ICliServerAuth = {
            protectServer: false,
            handlesPath: () => false,
            authenticateRequest: async () => ({ userId: 'u', userName: 'u', permissions: [] }),
            consumeTicket: async () => undefined,
            hasPermission: () => false,
            attachToServer: (server) => {
                arg = server;
            },
        };
        cli.setAuth(auth);
        expect(arg.permissions).toBe(cli.builder.permissions);
    });
});
