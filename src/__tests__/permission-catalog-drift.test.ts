/**
 * Drift guard: core's `CliPermissionCatalog` and the users plugin's own
 * `LocalPermissionCatalog` (a copy, since the plugin may not import core) must accept,
 * refuse and order registrations identically, with the same error texts.
 */
import { describe, it, expect } from 'vitest';
import { CliPermissionCatalog } from '../permissions/cli-permission-catalog';
import { LocalPermissionCatalog } from '../../plugins/users/permissions';

type Entry = { name: string; description: string; group: string };
type Surface = 'cli' | 'host';
type Catalog = { add(entries: readonly Entry[], surface: Surface): void; all(): unknown[]; find(name: string): unknown };

const e = (name: string, description = 'd', group = 'g'): Entry => ({ name, description, group });

/** Each case: registrations applied in order to an empty catalog. */
const CASES: { title: string; steps: { entries: Entry[]; surface: Surface }[]; finds?: string[] }[] = [
    { title: 'valid entries', steps: [{ entries: [e('a:b'), e('x_1.y-2:z.w_3')], surface: 'cli' }], finds: ['A:B', 'x_1.y-2:z.w_3', 'nope:x'] },
    { title: 'longest description and group', steps: [{ entries: [e('a:b', 'x'.repeat(200), 'x'.repeat(64))], surface: 'host' }] },
    ...['rates', 'rates:*', '*', 'Rates:Read', 'a:b:c', '', ' a:b', 'a :b', 'a:'].map((name) => ({
        title: `invalid name ${JSON.stringify(name)}`,
        steps: [{ entries: [e(name)], surface: 'host' as Surface }],
    })),
    { title: 'empty description', steps: [{ entries: [e('a:b', '')], surface: 'cli' }] },
    { title: '201-char description', steps: [{ entries: [e('a:b', 'x'.repeat(201))], surface: 'cli' }] },
    { title: 'two-line description', steps: [{ entries: [e('a:b', 'one\ntwo')], surface: 'cli' }] },
    { title: 'empty group', steps: [{ entries: [e('a:b', 'd', '')], surface: 'cli' }] },
    { title: '65-char group', steps: [{ entries: [e('a:b', 'd', 'x'.repeat(65))], surface: 'cli' }] },
    { title: 'bad surface', steps: [{ entries: [e('a:b')], surface: 'other' as Surface }] },
    { title: 'duplicate', steps: [{ entries: [e('files:read')], surface: 'cli' }, { entries: [e('files:read')], surface: 'host' }] },
    {
        title: 'case-insensitive duplicate, reported before the syntax check',
        steps: [{ entries: [e('files:read')], surface: 'cli' }, { entries: [e('FILES:READ')], surface: 'host' }],
    },
    { title: 'in-batch duplicate', steps: [{ entries: [e('a:b'), e('A:B')], surface: 'cli' }] },
    {
        title: 'all-or-nothing batch (invalid last)',
        steps: [{ entries: [e('a:b'), e('c:d'), e('bad')], surface: 'cli' }],
        finds: ['a:b', 'c:d'],
    },
    {
        title: 'all-or-nothing batch (duplicate last)',
        steps: [{ entries: [e('z:z')], surface: 'cli' }, { entries: [e('a:b'), e('z:z')], surface: 'host' }],
        finds: ['a:b'],
    },
    {
        title: 'cli entries before host entries, each in registration order',
        steps: [
            { entries: [e('rates:read'), e('banks:read')], surface: 'host' },
            { entries: [e('files:read')], surface: 'cli' },
            { entries: [e('zeta:read')], surface: 'host' },
            { entries: [e('users:read'), e('aaa:read')], surface: 'cli' },
        ],
    },
];

function run(catalog: Catalog, steps: { entries: Entry[]; surface: Surface }[], finds: string[] = []) {
    const errors = steps.map((step) => {
        try {
            catalog.add(step.entries, step.surface);
            return null;
        } catch (err) {
            return (err as Error).message;
        }
    });
    return { errors, all: catalog.all(), finds: finds.map((n) => catalog.find(n) ?? null) };
}

describe('permission catalog drift guard (core vs users plugin)', () => {
    for (const c of CASES) {
        it(c.title, () => {
            const core = run(new CliPermissionCatalog(), c.steps, c.finds);
            const local = run(new LocalPermissionCatalog(), c.steps, c.finds);
            expect(local).toEqual(core);
        });
    }

    it('the cases exercise what they claim', () => {
        const byTitle = (t: string) => run(new CliPermissionCatalog(), CASES.find((c) => c.title === t)!.steps, CASES.find((c) => c.title === t)!.finds);
        expect(byTitle('case-insensitive duplicate, reported before the syntax check').errors).toEqual([null, 'permission already registered: FILES:READ']);
        expect(byTitle('in-batch duplicate').errors).toEqual(['permission already registered: A:B']);
        expect(byTitle('invalid name "Rates:Read"').errors).toEqual(['invalid permission entry: Rates:Read']);
        expect(byTitle('all-or-nothing batch (invalid last)')).toMatchObject({ errors: ['invalid permission entry: bad'], all: [], finds: [null, null] });
        expect(byTitle('all-or-nothing batch (duplicate last)')).toMatchObject({ errors: [null, 'permission already registered: z:z'], finds: [null] });
        expect((byTitle('cli entries before host entries, each in registration order').all as { name: string }[]).map((p) => p.name)).toEqual([
            'files:read',
            'users:read',
            'aaa:read',
            'rates:read',
            'banks:read',
            'zeta:read',
        ]);
    });
});
