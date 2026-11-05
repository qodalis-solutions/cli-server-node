/**
 * The name and icon an application ships the admin dashboard under: its
 * title and icon (browser tab, sidebar, sign-in page) and the name of its
 * terminal (the CLI's welcome banner). Served with the color scheme in
 * `theme.json`; anything left out keeps the Qodalis default (Qodalis Cli
 * Admin, the Qodalis Solutions logo, Web CLI).
 */
export interface AdminBranding {
    /** The dashboard's name, e.g. `RateBell`. */
    name?: string;
    /** An absolute http(s) URL, a root-relative path (`/favicon.svg`) or a base64 `data:image/...` URL. */
    iconUrl?: string;
    /** The terminal's name in its welcome banner, e.g. `RateBell CLI`. */
    cliName?: string;
}

/** The `branding` part of `theme.json`: only the set values. */
export interface AdminBrandingDocument {
    name?: string;
    icon?: string;
    cli?: { name: string };
}

const MAX_NAME = 80;
const MAX_ICON = 200_000;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/;
// eslint-disable-next-line no-control-regex -- names are one line of plain text
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function text(value: unknown, property: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`Admin branding "${property}" must be a string`);
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.length > MAX_NAME) throw new Error(`Admin branding "${property}" is longer than ${MAX_NAME} characters`);
    if (CONTROL.test(trimmed)) throw new Error(`Admin branding "${property}" may not contain control characters`);
    return trimmed;
}

/** True for an absolute http(s) URL, a root-relative path or a base64 `data:image` URL. */
export function isBrandingIcon(value: unknown): value is string {
    if (typeof value !== 'string' || !value || value.length > MAX_ICON) return false;
    if (DATA_IMAGE.test(value)) return true;
    if (value.startsWith('/')) return !/^\/[/\\]/.test(value) && !/[\s\u0000-\u001f\u007f]/.test(value);
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
    } catch {
        return false;
    }
}

/** Validates the branding (throws on a bad value) and returns its `theme.json` part, or undefined when nothing is set. */
export function validateAdminBranding(branding: AdminBranding | undefined | null): AdminBrandingDocument | undefined {
    if (!branding) return undefined;
    const doc: AdminBrandingDocument = {};
    const name = text(branding.name, 'name');
    if (name) doc.name = name;
    const icon = typeof branding.iconUrl === 'string' ? branding.iconUrl.trim() : branding.iconUrl;
    if (icon) {
        if (!isBrandingIcon(icon)) {
            throw new Error('Admin branding "iconUrl" must be an absolute http(s) URL, a root-relative path or a base64 data:image URL');
        }
        doc.icon = icon;
    }
    const cliName = text(branding.cliName, 'cliName');
    if (cliName) doc.cli = { name: cliName };
    return Object.keys(doc).length > 0 ? doc : undefined;
}
