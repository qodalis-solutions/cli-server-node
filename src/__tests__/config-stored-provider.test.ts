/**
 * CliStoredConfigProvider (settings described in code, changes in a store) and the custom provider.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    CliConfigConflictError,
    CliStoredConfigProvider,
    InMemoryConfigStore,
    createCustomConfigProvider,
    type CliConfigValue,
} from '@qodalis/cli-server-abstractions';

function billing(apply: Record<string, (v: CliConfigValue) => void> = {}) {
    return new CliStoredConfigProvider({
        id: 'billing',
        title: 'Billing',
        description: 'Invoices',
        order: 5,
        requiredPermission: 'billing:admin',
        sections: [
            {
                id: 'invoices',
                title: 'Invoices',
                settings: [
                    { key: 'dueDays', label: 'Due in', type: 'number', default: 30, validation: { min: 1, max: 90 }, apply: apply.dueDays },
                    { key: 'apiKey', type: 'secret', apply: apply.apiKey },
                    { key: 'endpoint', type: 'url', default: 'https://pay.example', sensitive: true },
                    { key: 'currency', type: 'enum', default: 'EUR', validation: { options: ['EUR', 'USD'] }, source: 'environment' },
                    { key: 'region', type: 'string', mutable: false, value: () => 'eu-1', requiresRestart: true },
                    { key: 'even', type: 'number', default: 2, validate: (v) => ((v as number) % 2 === 0 ? undefined : 'must be even') },
                ],
            },
            { id: 'info', settings: [{ key: 'build', type: 'string', mutable: false, default: '1.2.3' }] },
        ],
    });
}

describe('CliStoredConfigProvider: definition', () => {
    it('refuses invalid or duplicate sections and keys', () => {
        const make = (sections: any[]) => () => new CliStoredConfigProvider({ id: 'x', title: 'X', sections });
        expect(make([{ id: 'a', settings: [] }, { id: 'a', settings: [] }])).toThrow('invalid or duplicate config section: a');
        expect(make([{ id: 'bad id', settings: [] }])).toThrow('invalid or duplicate config section');
        expect(make([{ id: 'a', settings: [{ key: 'k', type: 'string' }, { key: 'k', type: 'string' }] }])).toThrow('invalid or duplicate config key: a.k');
        expect(make([{ id: 'a', settings: [{ key: '', type: 'string' }] }])).toThrow('invalid or duplicate config key');
    });

    it('exposes id, title, description, order and requiredPermission', () => {
        const p = billing();
        expect([p.id, p.title, p.description, p.order, p.requiredPermission]).toEqual(['billing', 'Billing', 'Invoices', 5, 'billing:admin']);
    });
});

describe('CliStoredConfigProvider: reading', () => {
    it('entries carry defaults, sources, flags and rules; read-only values are live', async () => {
        const p = billing();
        const [invoices, info] = await p.getSections();
        expect(invoices.id).toBe('invoices');
        expect(invoices.title).toBe('Invoices');
        expect(invoices.version).toBe('0');
        const due = invoices.entries.find((e) => e.key === 'dueDays')!;
        expect(due).toEqual({
            key: 'dueDays',
            label: 'Due in',
            type: 'number',
            value: 30,
            default: 30,
            source: 'default',
            origin: 'default',
            mutable: true,
            requiresRestart: false,
            sensitive: false,
            validation: { min: 1, max: 90 },
        });
        expect(invoices.entries.find((e) => e.key === 'currency')!).toMatchObject({ source: 'environment', origin: 'code' });
        const region = invoices.entries.find((e) => e.key === 'region')!;
        expect(region).toMatchObject({ value: 'eu-1', mutable: false, requiresRestart: true });
        // A section without a mutable setting has no version
        expect(info.version).toBeUndefined();
        expect(info.entries[0]).toMatchObject({ key: 'build', value: '1.2.3', mutable: false });
    });

    it('never returns a secret or sensitive value: only isSet', async () => {
        const p = billing();
        await p.update('invoices', { apiKey: 'sk_live_123' }, undefined);
        const [invoices] = await p.getSections();
        expect(invoices.entries.find((e) => e.key === 'apiKey')).toMatchObject({ value: null, default: null, isSet: true, sensitive: true });
        expect(invoices.entries.find((e) => e.key === 'endpoint')).toMatchObject({ value: null, default: null, isSet: true, sensitive: true });
        expect(JSON.stringify(invoices)).not.toContain('sk_live_123');
        expect(JSON.stringify(invoices)).not.toContain('pay.example');
        // The host's code reads it
        expect(p.value('invoices', 'apiKey')).toBe('sk_live_123');
    });

    it('value(): stored, else default; read-only live; unknown undefined', async () => {
        const p = billing();
        expect(p.value('invoices', 'dueDays')).toBe(30);
        await p.update('invoices', { dueDays: 45 }, undefined);
        expect(p.value('invoices', 'dueDays')).toBe(45);
        expect(p.value('invoices', 'region')).toBe('eu-1');
        expect(p.value('invoices', 'nope')).toBeUndefined();
        expect(p.value('nope', 'dueDays')).toBeUndefined();
        expect(p.value('info', 'build')).toBe('1.2.3');
    });
});

describe('CliStoredConfigProvider: validate', () => {
    it('unknown keys, read-only keys and custom rules', () => {
        const p = billing();
        expect(p.validate('invoices', { nope: 1, region: 'x', even: 3, dueDays: 10 })).toEqual({
            nope: 'unknown setting',
            region: 'read-only',
            even: 'must be even',
        });
        expect(p.validate('invoices', { even: null })).toEqual({});
        expect(p.validate('missing', { a: 1 })).toEqual({});
    });
});

describe('CliStoredConfigProvider: update', () => {
    it('stores, bumps the version, applies the effective value and reports restart', async () => {
        const dueDays = vi.fn();
        const p = billing({ dueDays });
        const result = await p.update('invoices', { dueDays: 60 }, '0');
        expect(result).toEqual({ applied: ['dueDays'], requiresRestart: false, version: '1' });
        expect(dueDays).toHaveBeenCalledWith(60);
        const [invoices] = await p.getSections();
        expect(invoices.version).toBe('1');
        expect(invoices.entries.find((e) => e.key === 'dueDays')).toMatchObject({ value: 60, source: 'runtime' });
    });

    it('null resets to the default and applies it', async () => {
        const dueDays = vi.fn();
        const p = billing({ dueDays });
        await p.update('invoices', { dueDays: 60 }, undefined);
        await p.update('invoices', { dueDays: null }, undefined);
        expect(dueDays).toHaveBeenLastCalledWith(30);
        const [invoices] = await p.getSections();
        expect(invoices.entries.find((e) => e.key === 'dueDays')).toMatchObject({ value: 30, source: 'default' });
    });

    it('a secret is replaced and cleared, never read back', async () => {
        const apiKey = vi.fn();
        const p = billing({ apiKey });
        await p.update('invoices', { apiKey: 'one' }, undefined);
        await p.update('invoices', { apiKey: 'two' }, undefined);
        expect(p.value('invoices', 'apiKey')).toBe('two');
        await p.update('invoices', { apiKey: null }, undefined);
        expect(apiKey).toHaveBeenLastCalledWith(null);
        const [invoices] = await p.getSections();
        expect(invoices.entries.find((e) => e.key === 'apiKey')).toMatchObject({ value: null, isSet: false });
    });

    it('a stale or malformed version is a conflict with the current version', async () => {
        const p = billing();
        await p.update('invoices', { dueDays: 10 }, '0');
        const stale = await p.update('invoices', { dueDays: 11 }, '0').catch((e) => e);
        expect(stale).toBeInstanceOf(CliConfigConflictError);
        expect(stale.currentVersion).toBe('1');
        const bad = await p.update('invoices', { dueDays: 11 }, 'abc').catch((e) => e);
        expect(bad).toBeInstanceOf(CliConfigConflictError);
        expect(bad.currentVersion).toBe('1');
        expect(p.value('invoices', 'dueDays')).toBe(10);
    });

    it('requiresRestart when a changed setting needs one', async () => {
        const p = new CliStoredConfigProvider({
            id: 'x',
            title: 'X',
            sections: [{ id: 's', settings: [{ key: 'port', type: 'number', default: 1, requiresRestart: true }, { key: 'b', type: 'boolean', default: false }] }],
        });
        expect((await p.update('s', { b: true }, undefined)).requiresRestart).toBe(false);
        expect((await p.update('s', { port: 2, b: false }, undefined)).requiresRestart).toBe(true);
    });

    it('an unknown section throws', async () => {
        await expect(billing().update('nope', { a: 1 }, undefined)).rejects.toThrow('unknown config section: billing.nope');
    });
});

describe('CliStoredConfigProvider: the store', () => {
    it('attachStore applies stored values (mutable settings only) and uses the store source', async () => {
        const store = new InMemoryConfigStore();
        await store.write('billing', 'invoices', { dueDays: 14, region: 'stored-but-read-only', apiKey: 'k' });
        const dueDays = vi.fn();
        const apiKey = vi.fn();
        const p = billing({ dueDays, apiKey });
        await p.attachStore(store);
        await p.ready();
        expect(dueDays).toHaveBeenCalledWith(14);
        expect(apiKey).toHaveBeenCalledWith('k');
        const [invoices] = await p.getSections();
        expect(invoices.version).toBe('1');
        expect(invoices.entries.find((e) => e.key === 'dueDays')).toMatchObject({ value: 14, source: 'runtime' });
        expect(invoices.entries.find((e) => e.key === 'region')!.value).toBe('eu-1');
    });

    it('two providers on one store keep their sections apart; changes reach the store', async () => {
        const store = new InMemoryConfigStore();
        const a = billing();
        await a.attachStore(store);
        await a.update('invoices', { dueDays: 7 }, undefined);
        expect(await store.read('billing', 'invoices')).toEqual({ values: { dueDays: 7 }, version: 1 });
        // A second instance (a restart) sees it
        const b = billing();
        await b.attachStore(store);
        expect(b.value('invoices', 'dueDays')).toBe(7);
    });

    it('a failing store rejects ready()', async () => {
        const store = { source: 'database' as const, read: async () => Promise.reject(new Error('db down')), write: async () => Promise.reject(new Error('db down')) };
        const p = billing();
        await expect(p.attachStore(store)).rejects.toThrow('db down');
        await expect(p.ready()).rejects.toThrow('db down');
    });

    it('without attachStore the provider keeps changes in memory', async () => {
        const p = billing();
        await expect(p.ready()).resolves.toBeUndefined();
        await p.update('invoices', { dueDays: 3 }, undefined);
        expect(p.value('invoices', 'dueDays')).toBe(3);
    });
});

describe('createCustomConfigProvider', () => {
    it('one free section: keys are added with their type inferred, and removed with null', async () => {
        const p = createCustomConfigProvider();
        expect([p.id, p.title, p.order]).toEqual(['custom', 'Custom', 1000]);
        let [custom] = await p.getSections();
        expect(custom).toMatchObject({ id: 'custom', allowCustomKeys: true, version: '0', entries: [] });

        await p.update('custom', { motd: 'hello', retries: 3, beta: true, tags: ['a'], limits: { a: 1 } }, '0');
        [custom] = await p.getSections();
        expect(custom.entries.map((e) => [e.key, e.type, e.value, e.mutable, e.source])).toEqual([
            ['motd', 'string', 'hello', true, 'runtime'],
            ['retries', 'number', 3, true, 'runtime'],
            ['beta', 'boolean', true, true, 'runtime'],
            ['tags', 'string[]', ['a'], true, 'runtime'],
            ['limits', 'json', { a: 1 }, true, 'runtime'],
        ]);
        expect(p.value('custom', 'motd')).toBe('hello');

        await p.update('custom', { motd: null }, '1');
        [custom] = await p.getSections();
        expect(custom.entries.map((e) => e.key)).toEqual(['retries', 'beta', 'tags', 'limits']);
        expect(p.value('custom', 'motd')).toBeUndefined();
    });

    it('refuses keys that are not identifiers', () => {
        const p = createCustomConfigProvider();
        expect(p.validate('custom', { 'bad key': 1, 'ok.key-1_x': 2 })).toEqual({ 'bad key': 'invalid key: use letters, digits, _, - and .' });
    });

    it('options: id, title, description and order', () => {
        const p = createCustomConfigProvider({ id: 'app', title: 'App', description: 'mine', order: 7 });
        expect([p.id, p.title, p.description, p.order]).toEqual(['app', 'App', 'mine', 7]);
    });
});
