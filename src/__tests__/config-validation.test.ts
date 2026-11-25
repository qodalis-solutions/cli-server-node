/**
 * Config providers: value validation (every type and rule), terminal input parsing,
 * durations, type inference, permission matching and contexts.
 */
import { describe, it, expect } from 'vitest';
import {
    CLI_CONFIG_ENTRY_TYPES,
    cliConfigContext,
    cliConfigValuesEqual,
    cliPermissionMatches,
    cloneCliConfigValue,
    formatCliConfigDuration,
    hasCliPermission,
    inferCliConfigEntryType,
    isCliConfigWriter,
    isCliConfigError,
    CliConfigError,
    parseCliConfigDuration,
    parseCliConfigInput,
    validateCliConfigValue,
    type CliConfigEntry,
} from '@qodalis/cli-server-abstractions';

const v = (entry: Pick<CliConfigEntry, 'type' | 'validation' | 'default'>, value: unknown) => validateCliConfigValue(entry, value);

describe('validateCliConfigValue: types', () => {
    it('string', () => {
        expect(v({ type: 'string' }, 'x')).toBeUndefined();
        expect(v({ type: 'string' }, '')).toBeUndefined();
        expect(v({ type: 'string' }, 1)).toBe('must be a string');
        expect(v({ type: 'string' }, ['a'])).toBe('must be a string');
    });

    it('secret', () => {
        expect(v({ type: 'secret' }, 's3cr3t')).toBeUndefined();
        expect(v({ type: 'secret' }, 42)).toBe('must be a string');
    });

    it('number', () => {
        expect(v({ type: 'number' }, 0)).toBeUndefined();
        expect(v({ type: 'number' }, -1.5)).toBeUndefined();
        expect(v({ type: 'number' }, '1')).toBe('must be a number');
        expect(v({ type: 'number' }, Number.NaN)).toBe('must be a number');
        expect(v({ type: 'number' }, Number.POSITIVE_INFINITY)).toBe('must be a number');
    });

    it('boolean', () => {
        expect(v({ type: 'boolean' }, true)).toBeUndefined();
        expect(v({ type: 'boolean' }, false)).toBeUndefined();
        expect(v({ type: 'boolean' }, 'true')).toBe('must be true or false');
        expect(v({ type: 'boolean' }, 1)).toBe('must be true or false');
    });

    it('string[]', () => {
        expect(v({ type: 'string[]' }, [])).toBeUndefined();
        expect(v({ type: 'string[]' }, ['a', 'b'])).toBeUndefined();
        expect(v({ type: 'string[]' }, 'a')).toBe('must be a list of strings');
        expect(v({ type: 'string[]' }, ['a', 1])).toBe('must be a list of strings');
    });

    it('enum', () => {
        const entry = { type: 'enum' as const, validation: { options: ['a', 'b'] } };
        expect(v(entry, 'a')).toBeUndefined();
        expect(v(entry, 'c')).toBe('must be one of: a, b');
        expect(v(entry, 1)).toBe('must be a string');
        expect(v({ type: 'enum' }, 'a')).toBe('must be one of: ');
    });

    it('json: any JSON value', () => {
        for (const value of [{ a: [1, { b: null }] }, [1, 'x'], 'text', 3, true]) {
            expect(v({ type: 'json' }, value)).toBeUndefined();
        }
        expect(v({ type: 'json' }, { a: () => 1 })).toBe('must be a JSON value');
        expect(v({ type: 'json' }, { a: Number.NaN })).toBe('must be a JSON value');
        expect(v({ type: 'json' }, new Date())).toBe('must be a JSON value');
    });

    it('duration: <integer><ms|s|m|h|d>', () => {
        for (const value of ['500ms', '30s', '15m', '12h', '7d', '0s']) {
            expect(v({ type: 'duration' }, value)).toBeUndefined();
        }
        for (const value of ['1.5h', '10', 'h', '5w', '-1s', '1h30m', 60_000]) {
            expect(v({ type: 'duration' }, value)).toBe('must be a duration such as 500ms, 30s, 15m, 12h or 7d');
        }
    });

    it('url: an absolute URL with a scheme', () => {
        expect(v({ type: 'url' }, 'https://example.com/path?q=1')).toBeUndefined();
        expect(v({ type: 'url' }, 'postgres://db:5432/x')).toBeUndefined();
        expect(v({ type: 'url' }, '')).toBeUndefined();
        expect(v({ type: 'url' }, '/relative')).toBe('must be an absolute URL');
        expect(v({ type: 'url' }, 'mailto:a@b.c')).toBe('must be an absolute URL');
        expect(v({ type: 'url' }, 'not a url')).toBe('must be an absolute URL');
        expect(v({ type: 'url' }, 5)).toBe('must be a string');
    });

    it('an unknown type is refused', () => {
        expect(v({ type: 'color' as never }, 'red')).toBe('unknown type color');
    });

    it('covers every entry type', () => {
        expect(CLI_CONFIG_ENTRY_TYPES).toEqual(['string', 'number', 'boolean', 'string[]', 'enum', 'secret', 'json', 'duration', 'url']);
    });
});

describe('validateCliConfigValue: rules', () => {
    it('min / max: string length', () => {
        const entry = { type: 'string' as const, validation: { min: 2, max: 4 } };
        expect(v(entry, 'a')).toBe('must be at least 2 characters');
        expect(v(entry, 'abcde')).toBe('must be at most 4 characters');
        expect(v(entry, 'abc')).toBeUndefined();
    });

    it('min / max: secret and url length', () => {
        expect(v({ type: 'secret', validation: { min: 8 } }, 'short')).toBe('must be at least 8 characters');
        expect(v({ type: 'url', validation: { max: 10 } }, 'https://example.com')).toBe('must be at most 10 characters');
    });

    it('min / max: number value', () => {
        const entry = { type: 'number' as const, validation: { min: 1, max: 10 } };
        expect(v(entry, 0)).toBe('must be at least 1');
        expect(v(entry, 11)).toBe('must be at most 10');
        expect(v(entry, 1)).toBeUndefined();
        expect(v(entry, 10)).toBeUndefined();
    });

    it('min / max: string[] item count', () => {
        const entry = { type: 'string[]' as const, validation: { min: 1, max: 2 } };
        expect(v(entry, [])).toBe('must have at least 1 items');
        expect(v(entry, ['a', 'b', 'c'])).toBe('must have at most 2 items');
    });

    it('min / max: duration in milliseconds', () => {
        const entry = { type: 'duration' as const, validation: { min: 60_000, max: 86_400_000 } };
        expect(v(entry, '30s')).toBe('must be at least 1m');
        expect(v(entry, '2d')).toBe('must be at most 1d');
        expect(v(entry, '1h')).toBeUndefined();
    });

    it('pattern: string, each string[] item, url, secret', () => {
        expect(v({ type: 'string', validation: { pattern: '^[a-z]+$' } }, 'abc')).toBeUndefined();
        expect(v({ type: 'string', validation: { pattern: '^[a-z]+$' } }, 'ABC')).toBe('must match ^[a-z]+$');
        expect(v({ type: 'string[]', validation: { pattern: '^\\d+$' } }, ['1', 'x'])).toBe("'x' must match ^\\d+$");
        expect(v({ type: 'url', validation: { pattern: '^https:' } }, 'http://a.b')).toBe('must match ^https:');
        expect(v({ type: 'secret', validation: { pattern: '^sk_' } }, 'pk_1')).toBe('must match ^sk_');
    });

    it('an invalid pattern never matches', () => {
        expect(v({ type: 'string', validation: { pattern: '(' } }, 'x')).toBe('must match (');
    });

    it('options: string and each string[] item', () => {
        expect(v({ type: 'string', validation: { options: ['x', 'y'] } }, 'z')).toBe('must be one of: x, y');
        expect(v({ type: 'string', validation: { options: ['x', 'y'] } }, 'x')).toBeUndefined();
        expect(v({ type: 'string[]', validation: { options: ['x', 'y'] } }, ['x', 'z'])).toBe("'z' must be one of: x, y");
    });

    it('required: refuses empty values', () => {
        expect(v({ type: 'string', validation: { required: true } }, '')).toBe('is required');
        expect(v({ type: 'string[]', validation: { required: true } }, [])).toBe('is required');
        expect(v({ type: 'secret', validation: { required: true } }, '')).toBe('is required');
        expect(v({ type: 'string', validation: { required: true } }, 'x')).toBeUndefined();
    });

    it('null resets: allowed unless required without a default', () => {
        expect(v({ type: 'string' }, null)).toBeUndefined();
        expect(v({ type: 'string', validation: { required: true } }, null)).toBe('is required');
        expect(v({ type: 'string', validation: { required: true }, default: 'd' }, null)).toBeUndefined();
        expect(v({ type: 'number', validation: { min: 5 } }, null)).toBeUndefined();
    });
});

describe('parseCliConfigInput (terminal values)', () => {
    it('number', () => {
        expect(parseCliConfigInput('number', ' 42 ')).toBe(42);
        expect(parseCliConfigInput('number', '-1.5')).toBe(-1.5);
        expect(() => parseCliConfigInput('number', 'abc')).toThrow('must be a number');
        expect(() => parseCliConfigInput('number', '')).toThrow('must be a number');
    });

    it('boolean', () => {
        for (const t of ['true', 'YES', 'on', '1']) expect(parseCliConfigInput('boolean', t)).toBe(true);
        for (const t of ['false', 'No', 'off', '0']) expect(parseCliConfigInput('boolean', t)).toBe(false);
        expect(() => parseCliConfigInput('boolean', 'maybe')).toThrow('must be true or false');
    });

    it('string[]: comma-separated or a JSON array', () => {
        expect(parseCliConfigInput('string[]', 'a, b ,c')).toEqual(['a', 'b', 'c']);
        expect(parseCliConfigInput('string[]', '["a,b", "c"]')).toEqual(['a,b', 'c']);
        expect(parseCliConfigInput('string[]', '')).toEqual([]);
        expect(parseCliConfigInput('string[]', 'a,,b')).toEqual(['a', 'b']);
        expect(() => parseCliConfigInput('string[]', '[oops')).toThrow('must be a JSON array or a comma-separated list');
        expect(() => parseCliConfigInput('string[]', '[')).toThrow();
    });

    it('json', () => {
        expect(parseCliConfigInput('json', '{"a":1}')).toEqual({ a: 1 });
        expect(parseCliConfigInput('json', 'null')).toBeNull();
        expect(() => parseCliConfigInput('json', '{a')).toThrow('must be JSON');
    });

    it('everything else as typed', () => {
        expect(parseCliConfigInput('string', ' spaced ')).toBe(' spaced ');
        expect(parseCliConfigInput('secret', 'p@ss word')).toBe('p@ss word');
        expect(parseCliConfigInput('duration', '30m')).toBe('30m');
        expect(parseCliConfigInput('enum', 'a')).toBe('a');
        expect(parseCliConfigInput('url', 'https://x')).toBe('https://x');
    });
});

describe('durations', () => {
    it('parses one unit', () => {
        expect(parseCliConfigDuration('500ms')).toBe(500);
        expect(parseCliConfigDuration('30s')).toBe(30_000);
        expect(parseCliConfigDuration('15m')).toBe(900_000);
        expect(parseCliConfigDuration('2h')).toBe(7_200_000);
        expect(parseCliConfigDuration('7d')).toBe(604_800_000);
        expect(parseCliConfigDuration(' 1h ')).toBe(3_600_000);
        expect(parseCliConfigDuration('1h30m')).toBeUndefined();
        expect(parseCliConfigDuration(1000)).toBeUndefined();
    });

    it('formats in the largest unit that divides', () => {
        expect(formatCliConfigDuration(0)).toBe('0s');
        expect(formatCliConfigDuration(1500)).toBe('1500ms');
        expect(formatCliConfigDuration(90_000)).toBe('90s');
        expect(formatCliConfigDuration(1_800_000)).toBe('30m');
        expect(formatCliConfigDuration(86_400_000)).toBe('1d');
        expect(() => formatCliConfigDuration(-1)).toThrow();
    });

    it('round-trips', () => {
        for (const text of ['250ms', '45s', '5m', '6h', '30d']) {
            expect(formatCliConfigDuration(parseCliConfigDuration(text)!)).toBe(text);
        }
    });
});

describe('helpers', () => {
    it('infers the type of a free value', () => {
        expect(inferCliConfigEntryType(true)).toBe('boolean');
        expect(inferCliConfigEntryType(3)).toBe('number');
        expect(inferCliConfigEntryType(['a'])).toBe('string[]');
        expect(inferCliConfigEntryType([1])).toBe('json');
        expect(inferCliConfigEntryType({ a: 1 })).toBe('json');
        expect(inferCliConfigEntryType('x')).toBe('string');
        expect(inferCliConfigEntryType(null)).toBe('string');
    });

    it('clones and compares JSON values', () => {
        const value = { a: [1, 2] };
        const copy = cloneCliConfigValue(value);
        expect(copy).toEqual(value);
        expect(copy).not.toBe(value);
        expect(cloneCliConfigValue('x')).toBe('x');
        expect(cliConfigValuesEqual(['a'], ['a'])).toBe(true);
        expect(cliConfigValuesEqual(['a'], ['b'])).toBe(false);
        expect(cliConfigValuesEqual(1, 1)).toBe(true);
        expect(cliConfigValuesEqual(null, {})).toBe(false);
    });

    it('permission matching: wildcards, case-insensitive', () => {
        expect(cliPermissionMatches('*', 'config:write')).toBe(true);
        expect(cliPermissionMatches('config:*', 'config:read')).toBe(true);
        expect(cliPermissionMatches('*:read', 'config:read')).toBe(true);
        expect(cliPermissionMatches('*:read', 'config:write')).toBe(false);
        expect(cliPermissionMatches('CONFIG:READ', 'config:read')).toBe(true);
        expect(cliPermissionMatches('config', 'config:read')).toBe(false);
        expect(hasCliPermission(['files:read', 'config:read'], 'config:read')).toBe(true);
        expect(hasCliPermission(undefined, 'config:read')).toBe(false);
    });

    it('contexts: without a caller everything is allowed', () => {
        expect(cliConfigContext(undefined).hasPermission('config:write')).toBe(true);
        const ctx = cliConfigContext({ userName: 'ann', permissions: ['config:read'] }, 'api');
        expect(ctx.hasPermission('config:read')).toBe(true);
        expect(ctx.hasPermission('config:write')).toBe(false);
        expect(ctx.via).toBe('api');
        expect(ctx.caller?.userName).toBe('ann');
        expect(cliConfigContext({ userName: 'bob' }).hasPermission('config:read')).toBe(false);
    });

    it('writers and errors are recognised by shape', () => {
        expect(isCliConfigWriter({ validate: () => ({}), update: async () => ({}) })).toBe(true);
        expect(isCliConfigWriter({ getSections: () => [] })).toBe(false);
        expect(isCliConfigWriter(undefined)).toBe(false);
        const err = new CliConfigError(409, 'version conflict', undefined, '4');
        expect(isCliConfigError(err)).toBe(true);
        expect(err.toJSON()).toEqual({ error: 'version conflict', version: '4' });
        expect(new CliConfigError(400, 'validation failed', { a: 'bad' }).toJSON()).toEqual({ error: 'validation failed', errors: { a: 'bad' } });
        expect(isCliConfigError(new Error('x'))).toBe(false);
    });
});
