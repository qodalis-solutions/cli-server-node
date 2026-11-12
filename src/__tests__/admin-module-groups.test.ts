/**
 * The admin plugin's module registry lists commands registered on their own under the module
 * their `module` property names (mirrors the .NET ModuleRegistryCommandGroupsTests).
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CliAdminBuilder } from '../../plugins/admin';
import { ModuleRegistry } from '../../plugins/admin/services/module-registry';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { CliEventSocketManager } from '../services/cli-event-socket-manager';
import { CliBuilder } from '../extensions/cli-builder';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { ICliModule } from '@qodalis/cli-server-abstractions';

function cmd(command: string, module?: string, icon?: string): ICliCommandProcessor {
    return {
        command,
        description: command,
        author: DefaultLibraryAuthor,
        version: '1.2.3',
        ...(module ? { module } : {}),
        ...(icon ? { icon } : {}),
        handleAsync: async () => command,
    };
}

function setup(modules: ICliModule[], standalone: ICliCommandProcessor[]) {
    const registry = new CliCommandRegistry();
    const builder = new CliBuilder(registry);
    for (const p of standalone) builder.addProcessor(p);
    for (const m of modules) builder.addModule(m);
    return { registry, builder, modules: new ModuleRegistry(registry, builder) };
}

describe('ModuleRegistry command groups', () => {
    it('lists commands added on their own as the module they name', () => {
        const { modules } = setup([], [cmd('stats', 'shop'), cmd('plans', 'Shop'), cmd('loose')]);

        const list = modules.list();

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: 'shop', name: 'shop', processors: ['stats', 'plans'], processorCount: 2, icon: null });
        expect(list[0].version).not.toBe('');
    });

    it('a module with the same name describes them and keeps its icon', () => {
        const shop: ICliModule = { name: 'shop', version: '2.0.0', description: 'Shop admin', author: DefaultLibraryAuthor, processors: [], icon: '🛒' };
        const weather: ICliModule = { name: 'weather', version: '1.0.0', description: 'Weather', author: DefaultLibraryAuthor, processors: [cmd('test-cmd', 'weather')] };
        const { modules } = setup([shop, weather], [cmd('stats', 'SHOP')]);

        const list = modules.list();

        expect(list.map((p) => p.name)).toEqual(['shop', 'weather']);
        expect(list[0]).toMatchObject({ icon: '🛒', description: 'Shop admin', version: '2.0.0', processors: ['stats'] });
        // A module's own processor is not counted twice
        expect(list[1].processors).toEqual(['test-cmd']);
        expect(list[1].icon).toBeNull();
    });

    it('disabling the group blocks its commands', () => {
        const stats = cmd('stats', 'shop');
        const loose = cmd('loose');
        const { modules } = setup([], [stats, loose]);

        expect(modules.toggle('SHOP')!.enabled).toBe(false);

        expect(modules.isAllowed(stats)).toBe(false);
        expect(modules.isAllowed(loose)).toBe(true);
        expect(modules.toggle('shop')!.enabled).toBe(true);
        expect(modules.isAllowed(stats)).toBe(true);
    });

    it('the admin plugin groups the host commands and returns icons', async () => {
        const registry = new CliCommandRegistry();
        const builder = new CliBuilder(registry);
        const plugin = new CliAdminBuilder()
            .setCredentials('admin', 'pass')
            .setJwtSecret('secret')
            .build({ registry, eventSocketManager: new CliEventSocketManager(), builder });
        // Registered after the admin plugin: still listed
        builder.addProcessor(cmd('stats', 'shop', '📊'));
        builder.addModule({ name: 'shop', version: '1.0.0', description: 'Shop', author: DefaultLibraryAuthor, processors: [], icon: '🛒' });
        const app = express();
        app.use(express.json());
        app.use(plugin.prefix, plugin.router);
        const token = (await request(app).post('/api/v1/qcli/auth/login').send({ username: 'admin', password: 'pass' })).body.token;
        const auth = { Authorization: `Bearer ${token}` };

        const list = await request(app).get('/api/v1/qcli/plugins').set(auth);
        const shop = await request(app).get('/api/v1/qcli/plugins/SHOP').set(auth);
        const missing = await request(app).get('/api/v1/qcli/plugins/nope').set(auth);

        expect(list.body).toEqual([expect.objectContaining({ id: 'shop', icon: '🛒', processors: ['stats'] })]);
        expect(shop.status).toBe(200);
        expect(shop.body).toMatchObject({ id: 'shop', icon: '🛒', processors: ['stats'] });
        expect(missing.status).toBe(404);
        plugin.dispose();
    });
});
