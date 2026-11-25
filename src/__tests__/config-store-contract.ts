/**
 * The behaviour every config store shares (memory, JSON file, JSON file section, database,
 * Redis): run by config-stores.test.ts and config-redis.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CliConfigConflictError, type ICliConfigStore } from '@qodalis/cli-server-abstractions';

/** The behaviour every store shares. */
export function storeContract(name: string, create: () => Promise<ICliConfigStore>, cleanup?: () => Promise<void>) {
    describe(`${name}: the store contract`, () => {
        let store: ICliConfigStore;
        beforeEach(async () => {
            store = await create();
        });
        afterEach(async () => {
            await cleanup?.();
        });

        it('an unknown section is empty at version 0', async () => {
            expect(await store.read('p', 's')).toEqual({ values: {}, version: 0 });
        });

        it('writes bump the version by one and keep the values', async () => {
            const first = await store.write('p', 's', { a: 1, b: ['x'] });
            expect(first).toEqual({ values: { a: 1, b: ['x'] }, version: 1 });
            const second = await store.write('p', 's', { c: { deep: true } });
            expect(second).toEqual({ values: { a: 1, b: ['x'], c: { deep: true } }, version: 2 });
            expect(await store.read('p', 's')).toEqual(second);
        });

        it('null removes a key (reset)', async () => {
            await store.write('p', 's', { a: 1, b: 2 });
            const after = await store.write('p', 's', { a: null });
            expect(after.values).toEqual({ b: 2 });
            expect(after.version).toBe(2);
        });

        it('sections and providers are independent', async () => {
            await store.write('p', 's1', { a: 1 });
            await store.write('p', 's2', { a: 2 });
            await store.write('q', 's1', { a: 3 });
            expect((await store.read('p', 's1')).values).toEqual({ a: 1 });
            expect((await store.read('p', 's2')).values).toEqual({ a: 2 });
            expect((await store.read('q', 's1')).values).toEqual({ a: 3 });
            expect((await store.read('q', 's1')).version).toBe(1);
        });

        it('the expected version must match: a stale one is a conflict carrying the current version', async () => {
            await store.write('p', 's', { a: 1 }, 0);
            await store.write('p', 's', { a: 2 }, 1);
            const err = await store.write('p', 's', { a: 3 }, 1).catch((e) => e);
            expect(err).toBeInstanceOf(CliConfigConflictError);
            expect(err.currentVersion).toBe('2');
            expect((await store.read('p', 's')).values).toEqual({ a: 2 });
        });

        it('a first write with an expected version other than 0 is a conflict', async () => {
            await expect(store.write('p', 'new', { a: 1 }, 3)).rejects.toBeInstanceOf(CliConfigConflictError);
            expect(await store.read('p', 'new')).toEqual({ values: {}, version: 0 });
        });

        it('returned values are copies', async () => {
            const written = await store.write('p', 's', { list: ['a'] });
            (written.values.list as string[]).push('mutated');
            const read = await store.read('p', 's');
            (read.values.list as string[]).push('again');
            expect((await store.read('p', 's')).values.list).toEqual(['a']);
        });

        it('concurrent writes without an expected version never lose a change', async () => {
            await Promise.all(Array.from({ length: 5 }, (_, i) => store.write('p', 's', { [`k${i}`]: i })));
            const final = await store.read('p', 's');
            expect(final.version).toBe(5);
            expect(Object.keys(final.values).sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
        });

        it('one store keeps two providers apart: same section ids, own values and versions', async () => {
            await store.write('jobs', 'history', { maxAge: '30d' });
            await store.write('jobs', 'history', { maxRunsPerJob: 10 });
            await store.write('users', 'history', { maxAge: '1d' });
            expect(await store.read('jobs', 'history')).toEqual({ values: { maxAge: '30d', maxRunsPerJob: 10 }, version: 2 });
            expect(await store.read('users', 'history')).toEqual({ values: { maxAge: '1d' }, version: 1 });
            await expect(store.write('users', 'history', { maxAge: '2d' }, 2)).rejects.toBeInstanceOf(CliConfigConflictError);
            expect((await store.write('jobs', 'history', { maxAge: '7d' }, 2)).version).toBe(3);
        });

        it('secrets are stored as given', async () => {
            await store.write('p', 's', { apiKey: 'sk_live_1' });
            expect((await store.read('p', 's')).values.apiKey).toBe('sk_live_1');
        });
    });
}

