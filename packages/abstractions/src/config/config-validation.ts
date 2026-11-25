import type { CliConfigEntry, CliConfigEntryType, CliConfigValue } from './config-types';

const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A `duration` setting's value in milliseconds: a whole number and one unit, `ms`, `s`, `m`,
 * `h` or `d` (`500ms`, `30s`, `15m`, `12h`, `7d`); `0s` is zero. Undefined when it is not one.
 */
export function parseCliConfigDuration(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    const match = DURATION.exec(value.trim());
    return match ? Number(match[1]) * DURATION_MS[match[2]] : undefined;
}

/** Milliseconds as a duration in the largest unit that divides them (`90000` -> `90s`, `3600000` -> `1h`). */
export function formatCliConfigDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid duration: ${ms}`);
    const whole = Math.round(ms);
    if (whole === 0) return '0s';
    for (const unit of ['d', 'h', 'm', 's'] as const) {
        if (whole % DURATION_MS[unit] === 0) return `${whole / DURATION_MS[unit]}${unit}`;
    }
    return `${whole}ms`;
}

function isEmpty(value: unknown): boolean {
    return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function isJson(value: unknown, depth = 0): boolean {
    if (depth > 32) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((v) => isJson(v, depth + 1));
    if (isPlainObject(value)) return Object.values(value).every((v) => isJson(v, depth + 1));
    return false;
}

function matches(pattern: string, value: string): boolean {
    try {
        return new RegExp(pattern).test(value);
    } catch {
        return false;
    }
}

/**
 * Checks a new value against an entry's type and validation rules; the error message, or
 * undefined when valid. `null` resets the setting: refused only for a `required` entry
 * without a default. The rules, the same on every server:
 *
 * - `string`, `secret`: a string; `min`/`max` its length, `pattern`, `options`.
 * - `url`: an absolute URL (`scheme://...`); `min`/`max` length, `pattern`.
 * - `number`: a finite number; `min`/`max` its value.
 * - `boolean`: true or false.
 * - `enum`: one of `options`.
 * - `string[]`: an array of strings; `min`/`max` the item count, `pattern` and `options` each item.
 * - `duration`: `<integer><ms|s|m|h|d>`; `min`/`max` in milliseconds.
 * - `json`: any JSON value.
 * - `required`: not `''`, not `[]`.
 */
export function validateCliConfigValue(entry: Pick<CliConfigEntry, 'type' | 'validation' | 'default'>, value: unknown): string | undefined {
    const rules = entry.validation ?? {};
    if (value === null || value === undefined) {
        return rules.required && isEmpty(entry.default) ? 'is required' : undefined;
    }
    if (rules.required && isEmpty(value)) return 'is required';
    const lengthRules = (text: string): string | undefined => {
        if (rules.min !== undefined && text.length < rules.min) return `must be at least ${rules.min} characters`;
        if (rules.max !== undefined && text.length > rules.max) return `must be at most ${rules.max} characters`;
        if (rules.pattern !== undefined && !matches(rules.pattern, text)) return `must match ${rules.pattern}`;
        return undefined;
    };
    switch (entry.type) {
        case 'string':
        case 'secret': {
            if (typeof value !== 'string') return 'must be a string';
            const error = lengthRules(value);
            if (error) return error;
            if (rules.options && rules.options.length > 0 && value !== '' && !rules.options.includes(value)) {
                return `must be one of: ${rules.options.join(', ')}`;
            }
            return undefined;
        }
        case 'url': {
            if (typeof value !== 'string') return 'must be a string';
            if (value === '') return undefined;
            let url: URL | undefined;
            try {
                url = new URL(value);
            } catch {
                url = undefined;
            }
            if (!url || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return 'must be an absolute URL';
            return lengthRules(value);
        }
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
            if (rules.min !== undefined && value < rules.min) return `must be at least ${rules.min}`;
            if (rules.max !== undefined && value > rules.max) return `must be at most ${rules.max}`;
            return undefined;
        }
        case 'boolean':
            return typeof value === 'boolean' ? undefined : 'must be true or false';
        case 'enum': {
            if (typeof value !== 'string') return 'must be a string';
            const options = rules.options ?? [];
            return options.includes(value) ? undefined : `must be one of: ${options.join(', ')}`;
        }
        case 'string[]': {
            if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return 'must be a list of strings';
            if (rules.min !== undefined && value.length < rules.min) return `must have at least ${rules.min} items`;
            if (rules.max !== undefined && value.length > rules.max) return `must have at most ${rules.max} items`;
            for (const item of value as string[]) {
                if (rules.pattern !== undefined && !matches(rules.pattern, item)) return `'${item}' must match ${rules.pattern}`;
                if (rules.options && rules.options.length > 0 && !rules.options.includes(item)) {
                    return `'${item}' must be one of: ${rules.options.join(', ')}`;
                }
            }
            return undefined;
        }
        case 'duration': {
            const ms = parseCliConfigDuration(value);
            if (ms === undefined) return 'must be a duration such as 500ms, 30s, 15m, 12h or 7d';
            if (rules.min !== undefined && ms < rules.min) return `must be at least ${formatCliConfigDuration(rules.min)}`;
            if (rules.max !== undefined && ms > rules.max) return `must be at most ${formatCliConfigDuration(rules.max)}`;
            return undefined;
        }
        case 'json':
            return isJson(value) ? undefined : 'must be a JSON value';
        default:
            return `unknown type ${String(entry.type)}`;
    }
}

const TRUE = new Set(['true', 'yes', 'on', '1']);
const FALSE = new Set(['false', 'no', 'off', '0']);

/**
 * A value typed in the terminal (`config set cors.cors.allowedOrigins a,b`) as the entry's type:
 * `number` parsed, `boolean` from true/false/yes/no/on/off/1/0, `string[]` from a JSON array or a
 * comma-separated list, `json` parsed, anything else as typed. `null` (the word) for `json`
 * only; reset a setting with `config reset`. Throws with the reason when the text does not parse.
 */
export function parseCliConfigInput(type: CliConfigEntryType, text: string): CliConfigValue {
    const trimmed = text.trim();
    switch (type) {
        case 'number': {
            const n = Number(trimmed);
            if (trimmed === '' || !Number.isFinite(n)) throw new Error('must be a number');
            return n;
        }
        case 'boolean': {
            const lower = trimmed.toLowerCase();
            if (TRUE.has(lower)) return true;
            if (FALSE.has(lower)) return false;
            throw new Error('must be true or false');
        }
        case 'string[]': {
            if (trimmed.startsWith('[')) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    throw new Error('must be a JSON array or a comma-separated list');
                }
                if (!Array.isArray(parsed)) throw new Error('must be a JSON array or a comma-separated list');
                return parsed as string[];
            }
            return trimmed === '' ? [] : trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        }
        case 'json':
            try {
                return JSON.parse(trimmed) as CliConfigValue;
            } catch {
                throw new Error('must be JSON');
            }
        default:
            return text;
    }
}

/** The entry type of a value of a free key (a `custom` section): number, boolean, string[], json or string. */
export function inferCliConfigEntryType(value: unknown): CliConfigEntryType {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return value.every((v) => typeof v === 'string') ? 'string[]' : 'json';
    if (isPlainObject(value)) return 'json';
    return 'string';
}

/** A copy of a JSON value (so callers never share arrays or objects with a store). */
export function cloneCliConfigValue<T extends CliConfigValue | undefined>(value: T): T {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

/** True when two JSON values are equal. */
export function cliConfigValuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
