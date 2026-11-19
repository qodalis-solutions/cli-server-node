/**
 * The portal's options and their validation (the admin plugin's rules): name, logo,
 * theme colours, footer links and the mount path.
 */

/** Colour tokens of the portal, the dashboard's (the same names on every server). */
export const PORTAL_THEME_TOKENS = [
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

export type PortalThemeToken = (typeof PORTAL_THEME_TOKENS)[number];
export type PortalThemeColors = Partial<Record<PortalThemeToken, string>>;
export type PortalThemeMode = 'dark' | 'light' | 'system';

export interface PortalTheme {
    /** Default `system`. */
    mode?: PortalThemeMode;
    dark?: PortalThemeColors;
    light?: PortalThemeColors;
}

export interface PortalLink {
    label: string;
    /** An http(s) URL or a root-relative path. */
    url: string;
}

/** A plugin's section (the docs and public-api plugins' `portalSection`). */
export interface PortalSection {
    kind: 'docs' | 'api';
    title: string;
    basePath: string;
}

export const MAX_FOOTER_LINKS = 20;
const MAX_TEXT = 80;
const MAX_LOGO = 200_000;
const MAX_COLOR_LENGTH = 100;
const MODES: readonly string[] = ['dark', 'light', 'system'];
const TOKENS: ReadonlySet<string> = new Set(PORTAL_THEME_TOKENS);
// eslint-disable-next-line no-control-regex -- names are one line of plain text
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Colour syntax, as the admin theme accepts it (copied from the admin plugin's `admin-theme.ts`). */
const COLOR_PATTERNS = [
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
    /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([0-9a-z.,%+\-\s/]*\)$/i,
    /^[a-z]{3,30}$/i,
];

export function isPortalColor(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    return v.length > 0 && v.length <= MAX_COLOR_LENGTH && COLOR_PATTERNS.some((p) => p.test(v));
}

/** True for `/`, or `/segment[/segment...]` without a trailing `/`. */
export function isValidPortalPath(path: unknown): path is string {
    return typeof path === 'string' && (path === '/' || /^(\/[A-Za-z0-9._~-]+)+$/.test(path));
}

const isText = (value: unknown): value is string =>
    typeof value === 'string' && value.length >= 1 && value.length <= MAX_TEXT && !CONTROL.test(value);

/** A root-relative path (not `//host`) or an absolute http(s) URL. */
function isLink(value: unknown): value is string {
    if (typeof value !== 'string' || !value || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
    if (value.startsWith('/')) return !/^\/[/\\]/.test(value);
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
    } catch {
        return false;
    }
}

export function validateName(name: unknown): string {
    if (!isText(name)) throw new Error('portal name must be 1-80 characters without control characters');
    return name;
}

export function validateLogo(logo: unknown): string | null {
    if (logo === undefined || logo === null) return null;
    if (typeof logo === 'string' && logo.length <= MAX_LOGO && (DATA_IMAGE.test(logo) || isLink(logo))) return logo;
    throw new Error('portal logo must be an http(s) URL, a root-relative path or a data:image URL');
}

function validateColors(colors: unknown, scheme: 'dark' | 'light'): PortalThemeColors {
    if (colors === undefined || colors === null) return {};
    if (typeof colors !== 'object' || Array.isArray(colors)) {
        throw new Error(`invalid portal colour ${scheme}: ${String(colors)}`);
    }
    const result: PortalThemeColors = {};
    for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        if (!TOKENS.has(key) || !isPortalColor(value)) {
            throw new Error(`invalid portal colour ${scheme}.${key}: ${String(value)}`);
        }
        result[key as PortalThemeToken] = value.trim();
    }
    return result;
}

export function validateTheme(theme: PortalTheme | undefined): { mode: PortalThemeMode; dark: PortalThemeColors; light: PortalThemeColors } {
    const mode = theme?.mode ?? 'system';
    if (!MODES.includes(mode)) {
        throw new Error(`invalid portal theme mode: ${String(mode)}`);
    }
    return { mode, dark: validateColors(theme?.dark, 'dark'), light: validateColors(theme?.light, 'light') };
}

export function validateFooterLinks(links: PortalLink[]): PortalLink[] {
    return links.map((link, i) => {
        const label = link?.label;
        if (i >= MAX_FOOTER_LINKS || !isText(label) || !isLink(link?.url)) {
            throw new Error(`invalid portal footer link: ${typeof label === 'string' ? label : ''}`);
        }
        return { label, url: link.url };
    });
}
