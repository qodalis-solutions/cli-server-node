/**
 * Config registry and service: registration, ordering, the store, permission filtering,
 * validation, conflicts, secret masking, audit (config.update) and the config:changed event.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    CliConfigConflictError,
    CliConfigError,
    CliConfigValidationError,
    CliStoredConfigProvider,
    InMemoryConfigStore,
    cliConfigContext,
    createCustomConfigProvider,
    type AuditEntry,
    type CliConfigContext,
    type CliConfigSection,
    type ICliConfigProvider,
    type ICliConfigWriter,
} from '@qodalis/cli-server-abstractions';
import { CliConfigRegistry } from '../config/cli-config-registry';
import { CliConfigService, toCliConfigEntryView, toCliConfigSectionView } from '../config/cli-config-service';
import { CliEventBus } from '../services/cli-event-bus';

const all = cliConfigContext(undefined, 'api');
const as = (...permissions: string[]): CliConfigContext => cliConfigContext({ userId: 'u1', userName: 'ann', permissions }, 'api');

function readOnly(id: string, order?: number, requiredPermission?: string): ICliConfigProvider {
    return { id, title: id.toUpperCase(), order, requiredPermission, getSections: () => [{ id: 'main', entries: [{ key: 'k', type: 'string', value: id }] }] };
}

function app() {
    return new CliStoredConfigProvider({
        id: 'app',
        title: 'App',
        sections: [
            {
                id: 'main',
                settings: [
                    { key: 'name', type: 'string', default: 'demo', validation: { required: true, max: 10 } },
                    { key: 'limit', type: 'number', default: 5, validation: { min: 1, max: 10 } },
                    { key: 'apiKey', type: 'secret' },
                    { key: 'mode', type: 'enum', default: 'a', validation: { options: ['a', 'b'] } },
                    { key: 'fixed', type: 'string', mutable: false, default: 'x' },
                ],
            },
            { id: 'info', settings: [{ key: 'build', type: 'string', mutable: false, default: '1' }] },
        ],
    });
}

function setup(providers: ICliConfigProvider[] = [app()]) {
    const registry = new CliConfigRegistry();
    for (const p of providers) registry.add(p);
    registry.start();
    const audits: AuditEntry[] = [];
    const bus = new CliEventBus();
    const events: any[] = [];
    bus.subscribe('config:*', (e) => void events.push(e));
    const service = new CliConfigService(registry, { audit: () => async (e) => void audits.push(e), eventBus: () => bus });
    return { registry, service, audits, events };
}

describe('CliConfigRegistry', () => {
    it('validates ids and titles, refuses duplicates', () => {
        const r = new CliConfigRegistry();
        expect(() => r.add(readOnly('Bad Id'))).toThrow('invalid config provider: Bad Id');
        expect(() => r.add({ id: 'x', title: '', getSections: () => [] })).toThrow('needs a title');
        expect(() => r.add({ id: 'x', title: 'X' } as any)).toThrow('invalid config provider: x');
        r.add(readOnly('a'));
        expect(() => r.add(readOnly('a'))).toThrow('config provider already registered: a');
        expect(r.has('a')).toBe(true);
        expect(r.find('a')?.title).toBe('A');
        expect(r.find('b')).toBeUndefined();
    });

    it('sorts by order (default 100), then id', () => {
        const r = new CliConfigRegistry();
        r.add(readOnly('zeta'));
        r.add(readOnly('alpha'));
        r.add(readOnly('first', 0));
        r.add(readOnly('last', 1000));
        expect(r.providers.map((p) => p.id)).toEqual(['first', 'alpha', 'zeta', 'last']);
    });

    it('the default store: in memory by default, set before start, attached to stored providers (also those added later)', async () => {
        const r = new CliConfigRegistry();
        expect(r.defaultStore.source).toBe('runtime');
        const store = new InMemoryConfigStore();
        await store.write('app', 'main', { limit: 9 });
        await store.write('custom', 'custom', { a: 1 });
        r.setStore(store);
        const early = app();
        r.add(early);
        expect(r.started).toBe(false);
        r.start();
        r.start();
        expect(() => r.setStore(new InMemoryConfigStore())).toThrow('the config store must be set before the server is created');
        const late = createCustomConfigProvider();
        r.add(late);
        await r.ready();
        expect(early.value('main', 'limit')).toBe(9);
        expect(late.value('custom', 'a')).toBe(1);
    });

    it('ready() rejects when a provider fails to load', async () => {
        const r = new CliConfigRegistry();
        r.setStore({ source: 'database', read: () => Promise.reject(new Error('down')), write: () => Promise.reject(new Error('down')) });
        r.add(app());
        r.start();
        await expect(r.ready()).rejects.toThrow('down');
    });
});

describe('views', () => {
    it('entry: defaults filled, sensitive masked, isSet', () => {
        expect(toCliConfigEntryView({ key: 'k', type: 'string', value: 'v' }, true)).toEqual({
            key: 'k',
            label: 'k',
            description: '',
            type: 'string',
            value: 'v',
            default: null,
            source: 'default',
            origin: 'default',
            mutable: false,
            requiresRestart: false,
            sensitive: false,
        });
        expect(toCliConfigEntryView({ key: 'p', type: 'secret', value: 'hunter2', default: 'x', mutable: true }, true)).toMatchObject({
            value: null,
            default: null,
            sensitive: true,
            isSet: true,
            mutable: true,
        });
        expect(toCliConfigEntryView({ key: 'p', type: 'url', value: 'https://u:p@h', sensitive: true }, true)).toMatchObject({ value: null, isSet: true });
        expect(toCliConfigEntryView({ key: 'p', type: 'secret', isSet: false }, true).isSet).toBe(false);
        expect(toCliConfigEntryView({ key: 'p', type: 'secret', value: '' }, true).isSet).toBe(false);
        // Not a writer: nothing is mutable
        expect(toCliConfigEntryView({ key: 'k', type: 'string', mutable: true }, false).mutable).toBe(false);
        expect(toCliConfigEntryView({ key: 'k', type: 'string', editor: 'tags', validation: { options: ['a'] } }, true)).toMatchObject({
            editor: 'tags',
            validation: { options: ['a'] },
        });
    });

    it('section: mutable, version only when mutable, allowCustomKeys only for writers', () => {
        const section: CliConfigSection = { id: 's', entries: [{ key: 'k', type: 'string', mutable: true }], version: '3' };
        expect(toCliConfigSectionView(section, true)).toMatchObject({ id: 's', title: 's', description: '', mutable: true, version: '3', allowCustomKeys: false });
        expect(toCliConfigSectionView(section, false)).toMatchObject({ mutable: false, version: null });
        expect(toCliConfigSectionView({ id: 's', entries: [], allowCustomKeys: true, version: '0' }, true)).toMatchObject({ mutable: true, allowCustomKeys: true });
        expect(toCliConfigSectionView({ id: 's', entries: [], allowCustomKeys: true }, false)).toMatchObject({ mutable: false, allowCustomKeys: false });
        expect(toCliConfigSectionView({ id: 's', entries: [{ key: 'k', type: 'string', mutable: true }] }, true).version).toBeNull();
    });
});

describe('CliConfigService: reading', () => {
    it('list needs config:read', async () => {
        const { service } = setup();
        await expect(service.list(as())).rejects.toMatchObject({ status: 403, message: 'forbidden: missing permission config:read' });
        expect((await service.list(as('config:read'))).map((p) => p.id)).toEqual(['app']);
    });

    it('list filters by requiredPermission and sorts', async () => {
        const { service } = setup([readOnly('b'), readOnly('a', 1), readOnly('secret-stuff', 0, 'ops:root')]);
        expect((await service.list(as('config:read'))).map((p) => p.id)).toEqual(['a', 'b']);
        expect((await service.list(as('config:read', 'ops:root'))).map((p) => p.id)).toEqual(['secret-stuff', 'a', 'b']);
        expect((await service.list(all)).map((p) => p.id)).toEqual(['secret-stuff', 'a', 'b']);
    });

    it('provider view: writable only for a writer and config:write', async () => {
        const { service } = setup([app(), readOnly('ro')]);
        const [appView, ro] = await service.list(as('config:read'));
        expect(appView).toMatchObject({ id: 'app', title: 'App', description: '', order: 100, writable: false });
        expect((await service.get('app', as('config:read', 'config:write'))).writable).toBe(true);
        expect(ro.writable).toBe(false);
        expect(ro.sections[0]).toMatchObject({ mutable: false, version: null });
        // Entries stay mutable (what the provider allows); writable says what the caller may do
        expect(appView.sections[0].entries.find((e) => e.key === 'limit')!.mutable).toBe(true);
    });

    it('a failing provider is left out of the list, the others stay', async () => {
        const failing: ICliConfigProvider = { id: 'broken', title: 'Broken', getSections: () => Promise.reject(new Error('boom')) };
        const { service } = setup([failing, readOnly('ok')]);
        expect((await service.list(all)).map((p) => p.id)).toEqual(['ok']);
        await expect(service.get('broken', all)).rejects.toThrow('boom');
    });

    it('get: 403 without config:read, 404 unknown, 403 without requiredPermission', async () => {
        const { service } = setup([readOnly('a'), readOnly('guarded', 1, 'ops:root')]);
        await expect(service.get('a', as())).rejects.toMatchObject({ status: 403 });
        await expect(service.get('nope', as('config:read'))).rejects.toMatchObject({ status: 404, message: 'unknown config provider: nope' });
        await expect(service.get('guarded', as('config:read'))).rejects.toMatchObject({ status: 403, message: 'forbidden: missing permission ops:root' });
        expect((await service.get('guarded', as('config:read', 'ops:root'))).id).toBe('guarded');
    });

    it('never returns a secret', async () => {
        const { service } = setup();
        await service.update('app', 'main', { changes: { apiKey: 'sk_live_42' } }, all);
        const json = JSON.stringify(await service.list(all));
        expect(json).not.toContain('sk_live_42');
        const view = await service.get('app', all);
        expect(view.sections[0].entries.find((e) => e.key === 'apiKey')).toMatchObject({ value: null, isSet: true, sensitive: true });
    });

    it('a provider leaking a secret value is masked anyway', async () => {
        const leaky: ICliConfigProvider = { id: 'leaky', title: 'Leaky', getSections: () => [{ id: 's', entries: [{ key: 'token', type: 'secret', value: 'oops' }] }] };
        const { service } = setup([leaky]);
        expect(JSON.stringify(await service.get('leaky', all))).not.toContain('oops');
    });
});

describe('CliConfigService: update', () => {
    const write = as('config:read', 'config:write');

    it('needs config:write', async () => {
        const { service } = setup();
        await expect(service.update('app', 'main', { changes: { limit: 2 } }, as('config:read'))).rejects.toMatchObject({
            status: 403,
            message: 'forbidden: missing permission config:write',
        });
    });

    it('404 for an unknown provider or section; 403 for a guarded provider', async () => {
        const guarded = new CliStoredConfigProvider({ id: 'g', title: 'G', requiredPermission: 'ops:root', sections: [{ id: 's', settings: [{ key: 'k', type: 'string' }] }] });
        const { service } = setup([app(), guarded]);
        await expect(service.update('nope', 'main', { changes: { a: 1 } }, write)).rejects.toMatchObject({ status: 404 });
        await expect(service.update('app', 'nope', { changes: { a: 1 } }, write)).rejects.toMatchObject({ status: 404, message: 'unknown config section: app.nope' });
        await expect(service.update('g', 's', { changes: { k: 'v' } }, write)).rejects.toMatchObject({ status: 403 });
        await expect(service.update('g', 's', { changes: { k: 'v' } }, as('config:write', 'config:read', 'ops:root'))).resolves.toMatchObject({ version: '1' });
    });

    it('400 for a read-only provider or section', async () => {
        const { service } = setup([app(), readOnly('ro')]);
        await expect(service.update('ro', 'main', { changes: { k: 'x' } }, write)).rejects.toMatchObject({ status: 400, message: 'config provider ro is read-only' });
        await expect(service.update('app', 'info', { changes: { build: '2' } }, write)).rejects.toMatchObject({ status: 400, message: 'config section app.info is read-only' });
    });

    it('400 for a malformed body', async () => {
        const { service } = setup();
        for (const changes of [undefined, null, [], 'x', {}]) {
            await expect(service.update('app', 'main', { changes } as any, write)).rejects.toMatchObject({ status: 400, message: 'changes must be a non-empty object' });
        }
        await expect(service.update('app', 'main', { changes: { limit: 2 }, version: 3 } as any, write)).rejects.toMatchObject({ status: 400, message: 'version must be a string' });
    });

    it('400 with per-key errors: unknown, read-only, type and each rule', async () => {
        const { service } = setup();
        const err = await service
            .update('app', 'main', { changes: { nope: 1, fixed: 'y', limit: 'ten', name: '', mode: 'c', apiKey: 5 } }, write)
            .catch((e) => e);
        expect(err).toBeInstanceOf(CliConfigError);
        expect(err.status).toBe(400);
        expect(err.message).toBe('validation failed');
        expect(err.errors).toEqual({
            nope: 'unknown setting',
            fixed: 'read-only',
            limit: 'must be a number',
            name: 'is required',
            mode: 'must be one of: a, b',
            apiKey: 'must be a string',
        });
        const range = await service.update('app', 'main', { changes: { limit: 11, name: 'much too long' } }, write).catch((e) => e);
        expect(range.errors).toEqual({ limit: 'must be at most 10', name: 'must be at most 10 characters' });
        // Nothing changed
        const view = await service.get('app', all);
        expect(view.sections[0].version).toBe('0');
    });

    it("the writer's own validate errors are returned too", async () => {
        const writer: ICliConfigProvider & ICliConfigWriter = {
            id: 'w',
            title: 'W',
            getSections: () => [{ id: 's', version: '1', entries: [{ key: 'a', type: 'number', mutable: true }, { key: 'b', type: 'number', mutable: true }] }],
            validate: (_s, changes) => ((changes.a as number) > (changes.b as number) ? { a: 'must not exceed b' } : {}),
            update: vi.fn(async () => ({ applied: ['a', 'b'], requiresRestart: false, version: '2' })),
        };
        const { service } = setup([writer]);
        await expect(service.update('w', 's', { changes: { a: 5, b: 1 } }, write)).rejects.toMatchObject({ status: 400, errors: { a: 'must not exceed b' } });
        expect(writer.update).not.toHaveBeenCalled();
        await expect(service.update('w', 's', { changes: { a: 1, b: 5 } }, write)).resolves.toMatchObject({ version: '2' });
    });

    it('409 for a stale version, with the current one; nothing changes', async () => {
        const { service, audits, events } = setup();
        await service.update('app', 'main', { changes: { limit: 2 }, version: '0' }, write);
        const err = await service.update('app', 'main', { changes: { limit: 3 }, version: '0' }, write).catch((e) => e);
        expect(err).toMatchObject({ status: 409, message: 'version conflict', version: '1' });
        expect(err.toJSON()).toEqual({ error: 'version conflict', version: '1' });
        expect(audits).toHaveLength(1);
        expect(events).toHaveLength(1);
        expect((await service.get('app', all)).sections[0].entries.find((e) => e.key === 'limit')!.value).toBe(2);
    });

    it("409 when the writer reports a conflict (a change in between); 400 for the writer's late errors", async () => {
        const writer: ICliConfigProvider & ICliConfigWriter = {
            id: 'w',
            title: 'W',
            getSections: () => [{ id: 's', version: '1', entries: [{ key: 'a', type: 'number', mutable: true }] }],
            validate: () => ({}),
            update: vi
                .fn()
                .mockRejectedValueOnce(new CliConfigConflictError('7'))
                .mockRejectedValueOnce(new CliConfigValidationError({ a: 'taken' }))
                .mockRejectedValueOnce(new Error('disk full')),
        };
        const { service } = setup([writer]);
        await expect(service.update('w', 's', { changes: { a: 1 }, version: '1' }, write)).rejects.toMatchObject({ status: 409, version: '7' });
        await expect(service.update('w', 's', { changes: { a: 1 } }, write)).rejects.toMatchObject({ status: 400, errors: { a: 'taken' } });
        await expect(service.update('w', 's', { changes: { a: 1 } }, write)).rejects.toThrow('disk full');
    });

    it('applies without a version; answers the section, applied keys and the new version', async () => {
        const { service } = setup();
        const result = await service.update('app', 'main', { changes: { limit: 7, mode: 'b' } }, write);
        expect(result.provider).toBe('app');
        expect(result.applied).toEqual(['limit', 'mode']);
        expect(result.requiresRestart).toBe(false);
        expect(result.version).toBe('1');
        expect(result.section.version).toBe('1');
        expect(result.section.entries.find((e) => e.key === 'limit')).toMatchObject({ value: 7, source: 'runtime' });
    });

    it('null resets to the default', async () => {
        const { service } = setup();
        await service.update('app', 'main', { changes: { limit: 7 } }, write);
        const result = await service.update('app', 'main', { changes: { limit: null } }, write);
        expect(result.section.entries.find((e) => e.key === 'limit')).toMatchObject({ value: 5, source: 'default' });
    });

    it('custom keys: added, typed by their value, removed with null', async () => {
        const { service } = setup([createCustomConfigProvider()]);
        const added = await service.update('custom', 'custom', { changes: { motd: 'hi', 'feature.x': true } }, write);
        expect(added.section.entries.map((e) => [e.key, e.type, e.value])).toEqual([
            ['motd', 'string', 'hi'],
            ['feature.x', 'boolean', true],
        ]);
        await expect(service.update('custom', 'custom', { changes: { 'bad key': 1 } }, write)).rejects.toMatchObject({
            status: 400,
            errors: { 'bad key': 'invalid key: use letters, digits, _, - and .' },
        });
        await expect(service.update('custom', 'custom', { changes: { fn: { a: undefined, d: new Date() } } }, write)).rejects.toMatchObject({ status: 400 });
        const removed = await service.update('custom', 'custom', { changes: { motd: null } }, write);
        expect(removed.section.entries.map((e) => e.key)).toEqual(['feature.x']);
    });
});

describe('CliConfigService: audit and event', () => {
    const write = as('config:read', 'config:write');

    it('audits config.update with old and new values, the caller and the target', async () => {
        const { service, audits } = setup();
        await service.update('app', 'main', { changes: { limit: 8, mode: 'b' }, version: '0' }, write);
        expect(audits).toHaveLength(1);
        const entry = audits[0];
        expect(entry).toMatchObject({
            event: 'config.update',
            username: 'ann',
            userId: 'u1',
            actor: 'ann',
            actorId: 'u1',
            target: 'config:app.main',
            details: 'app.main: limit, mode',
        });
        expect(entry.properties).toEqual({
            provider: 'app',
            section: 'main',
            version: '1',
            store: 'memory',
            via: 'api',
            changes: [
                { key: 'limit', old: 5, new: 8 },
                { key: 'mode', old: 'a', new: 'b' },
            ],
        });
        expect(typeof entry.timestamp).toBe('number');
    });

    it('secrets are masked in the audit: set, replaced, cleared', async () => {
        const { service, audits } = setup();
        await service.update('app', 'main', { changes: { apiKey: 'first-secret' } }, write);
        await service.update('app', 'main', { changes: { apiKey: 'second-secret' } }, write);
        await service.update('app', 'main', { changes: { apiKey: null } }, write);
        expect(audits.map((a) => (a.properties as any).changes[0])).toEqual([
            { key: 'apiKey', old: null, new: '***' },
            { key: 'apiKey', old: '***', new: '***' },
            { key: 'apiKey', old: '***', new: null },
        ]);
        expect(JSON.stringify(audits)).not.toMatch(/first-secret|second-secret/);
    });

    it('anonymous callers (no auth) are audited as anonymous; removed custom keys as null', async () => {
        const { service, audits } = setup([createCustomConfigProvider()]);
        await service.update('custom', 'custom', { changes: { a: 1 } }, all);
        await service.update('custom', 'custom', { changes: { a: null } }, all);
        expect(audits[0]).toMatchObject({ username: 'anonymous', actor: 'anonymous' });
        expect(audits[0].userId).toBeUndefined();
        expect((audits[0].properties as any).changes).toEqual([{ key: 'a', old: null, new: 1 }]);
        expect((audits[1].properties as any).changes).toEqual([{ key: 'a', old: 1, new: null }]);
    });

    it('a failing audit sink does not fail the change; no sink, no audit', async () => {
        const registry = new CliConfigRegistry();
        registry.add(app());
        const service = new CliConfigService(registry, { audit: () => async () => Promise.reject(new Error('audit down')) });
        await expect(service.update('app', 'main', { changes: { limit: 2 } }, all)).resolves.toMatchObject({ version: '1' });
        const bare = new CliConfigService(registry);
        await expect(bare.update('app', 'main', { changes: { limit: 3 } }, all)).resolves.toMatchObject({ version: '2' });
    });

    it('publishes config:changed for config:read holders, without values', async () => {
        const { service, events } = setup();
        await service.update('app', 'main', { changes: { apiKey: 'shh', limit: 2 } }, write);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('config:changed');
        expect(events[0].audience).toEqual({ permission: 'config:read' });
        expect(events[0].data).toEqual({ provider: 'app', section: 'main', keys: ['apiKey', 'limit'], version: '1', requiresRestart: false, store: 'memory', user: 'ann' });
        expect(JSON.stringify(events)).not.toContain('shh');
    });

    it('no audit and no event for refused changes', async () => {
        const { service, audits, events } = setup();
        await service.update('app', 'main', { changes: { limit: 99 } }, write).catch(() => undefined);
        await service.update('app', 'main', { changes: { limit: 2 } }, as('config:read')).catch(() => undefined);
        expect(audits).toHaveLength(0);
        expect(events).toHaveLength(0);
    });
});
