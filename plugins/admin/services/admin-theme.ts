/**
 * Color scheme of the admin dashboard. The dashboard reads it from
 * `GET /qcli/admin/theme.json` before its first render; every token left out
 * keeps the dashboard's default (see the README for the list and defaults).
 */

/** Color tokens of the dashboard, the same names on every server. */
export const ADMIN_THEME_TOKENS = [
    'primary',
    'primaryHover',
    'onPrimary',
    'accent',
    'background',
    'backgroundAccent',
    'sidebar',
    'surface',
    'popover',
    'control',
    'controlHover',
    'border',
    'overlay',
    'heading',
    'text',
    'muted',
    'subtle',
    'success',
    'warning',
    'error',
    'info',
] as const;

export type AdminThemeToken = (typeof ADMIN_THEME_TOKENS)[number];

/** Overrides for one scheme: any subset of the tokens, as CSS colors. */
export type AdminThemeColors = Partial<Record<AdminThemeToken, string>>;

/** `dark` (default), `light`, or `system` to follow the browser's preference. */
export type AdminThemeMode = 'dark' | 'light' | 'system';

export interface AdminTheme {
    mode?: AdminThemeMode;
    dark?: AdminThemeColors;
    light?: AdminThemeColors;
}

/** What `theme.json` returns: the validated theme with the mode filled in. */
export interface AdminThemeDocument {
    mode: AdminThemeMode;
    dark: AdminThemeColors;
    light: AdminThemeColors;
}

const MODES: readonly string[] = ['dark', 'light', 'system'];
const TOKENS: ReadonlySet<string> = new Set(ADMIN_THEME_TOKENS);
const MAX_COLOR_LENGTH = 100;

/**
 * Accepted color syntax: a hex color, a color function with plain numeric
 * arguments, or a named color. Nothing that could end the declaration
 * (`;`, `{`, `}`, quotes) or load anything (`url(`, `var(`) gets through.
 */
const COLOR_PATTERNS = [
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
    /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([0-9a-z.,%+\-\s/]*\)$/i,
    /^[a-z]{3,30}$/i,
];

/** True when `value` is a color the dashboard accepts. */
export function isThemeColor(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    return v.length > 0 && v.length <= MAX_COLOR_LENGTH && COLOR_PATTERNS.some((p) => p.test(v));
}

function validateColors(colors: unknown, scheme: 'dark' | 'light'): AdminThemeColors {
    if (colors === undefined || colors === null) return {};
    if (typeof colors !== 'object' || Array.isArray(colors)) {
        throw new Error(`Invalid admin theme: "${scheme}" must be an object of colors`);
    }
    const result: AdminThemeColors = {};
    for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
        if (!TOKENS.has(key)) {
            throw new Error(
                `Invalid admin theme: unknown token "${scheme}.${key}" (expected one of ${ADMIN_THEME_TOKENS.join(', ')})`,
            );
        }
        if (value === undefined || value === null) continue;
        if (!isThemeColor(value)) {
            throw new Error(
                `Invalid admin theme color for "${scheme}.${key}": ${JSON.stringify(value)} (use a hex, rgb()/hsl()/oklch() or named color)`,
            );
        }
        result[key as AdminThemeToken] = value.trim();
    }
    return result;
}

/**
 * Validates a theme and returns the document served as `theme.json`.
 * Throws on an unknown mode or token, or a value that is not a plain color.
 */
export function validateAdminTheme(theme: AdminTheme | undefined | null): AdminThemeDocument {
    const t = (theme ?? {}) as Record<string, unknown>;
    if (typeof t !== 'object' || Array.isArray(t)) {
        throw new Error('Invalid admin theme: expected an object');
    }
    const mode = t.mode ?? 'dark';
    if (typeof mode !== 'string' || !MODES.includes(mode)) {
        throw new Error(`Invalid admin theme mode ${JSON.stringify(mode)} (expected dark, light or system)`);
    }
    return {
        mode: mode as AdminThemeMode,
        dark: validateColors(t.dark, 'dark'),
        light: validateColors(t.light, 'light'),
    };
}
