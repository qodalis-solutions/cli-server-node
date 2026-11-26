/**
 * A page a plugin adds to the admin dashboard: the dashboard lists it in its navigation and,
 * when it is opened, loads `entry` (an ES module) and mounts it (see the dashboard's
 * `docs/extensions.md`). Registered with `builder.addDashboardExtension(...)` or a mounted
 * plugin's `dashboardExtensions`; served by the admin plugin at
 * `GET /api/v1/qcli/dashboard/extensions`.
 */
export interface CliDashboardExtension {
    /** `^[a-z0-9][a-z0-9-]{0,39}$`, unique; also the page's path segment (`/x/<id>`). */
    id: string;
    /** 1-40 characters. */
    title: string;
    /** Titles by language code (`de`, `pt-BR`). */
    titles?: Record<string, string>;
    /** One emoji, or an http(s) or root-relative image URL. */
    icon?: string;
    /**
     * Navigation group: `overview`, `operations`, `data`, `access`, `system` (default; unknown values become it), or
     * `account`: listed in the dashboard's account menu (the signed-in user's menu) instead of the sidebar.
     */
    group?: string;
    /** Order within the group (default 100). */
    order?: number;
    /** The page shows only for users holding this permission (wildcards match). */
    permission?: string;
    /** The module's URL: a root-relative path (`/...`, not `//`) or an http(s) URL. */
    entry: string;
    /** Stylesheets (same rules as `entry`), at most 5. */
    styles?: string[];
    /** Shown in the page's error panel, and as the version added in code on the dashboard's Marketplace tab. */
    version?: string;
    /**
     * The npm package the page comes from (`@qodalis/cli-dashboard-module-jobs`): the dashboard's Marketplace tab
     * shows that package as added in code, and the server refuses to install it from the marketplace.
     */
    package?: string;
    /**
     * Slots the module fills besides its page: `overview` (cards on the dashboard's Overview: stats, panels,
     * "Needs attention" items), `palette` (entries of the dashboard's command palette, e.g. jump to a job). The
     * dashboard loads the module there too.
     */
    widgets?: string[];
    /**
     * A path below the page ending where search text goes (`/?q=`): the command palette offers
     * "Search <title> for …" and opens `/x/<id><search><text>`.
     */
    search?: string;
}

export const DASHBOARD_EXTENSION_GROUPS = ['overview', 'operations', 'data', 'access', 'system', 'account'] as const;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const WIDGET = /^[a-z][a-z0-9-]{0,39}$/;
const PACKAGE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const invalid = (reason: string) => new Error(`invalid dashboard extension: ${reason}`);

/** A root-relative path (not `//`, no whitespace or control characters) or an http(s) URL. */
function isUrl(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
    if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
    if (value.startsWith('/')) return !value.startsWith('//') && !value.startsWith('/\\');
    return /^https?:\/\/[^/]/i.test(value);
}

/** An icon: an image URL, or one emoji (one grapheme; a flag or family emoji is several code points). */
function isIcon(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (isUrl(value)) return true;
    if (value.length > 32 || /[\s<>"'/\\]/.test(value)) return false;
    return [...new Intl.Segmenter().segment(value)].length === 1;
}

/**
 * Validates a dashboard extension and returns a copy holding only the known fields (an unknown
 * group becomes `system`). Throws `invalid dashboard extension: <reason>`.
 */
export function validateDashboardExtension(input: CliDashboardExtension): CliDashboardExtension {
    if (!input || typeof input !== 'object') throw invalid('not an object');
    const { id, title, titles, icon, group, order, permission, entry, styles, version, widgets, search } = input;
    const pkg = input.package;
    if (typeof id !== 'string' || !ID.test(id)) throw invalid(`id must match ${ID.source}`);
    if (typeof title !== 'string' || title.trim().length === 0 || title.length > 40) throw invalid(`${id}: title must be 1-40 characters`);
    if (typeof entry !== 'string' || !isUrl(entry)) throw invalid(`${id}: entry must be a root-relative path or an http(s) URL`);
    const out: CliDashboardExtension = { id, title, entry };
    if (titles !== undefined) {
        if (!titles || typeof titles !== 'object' || Array.isArray(titles)) throw invalid(`${id}: titles must map language codes to titles`);
        const copy: Record<string, string> = {};
        for (const [language, text] of Object.entries(titles)) {
            if (!LANGUAGE.test(language) || typeof text !== 'string' || text.trim().length === 0 || text.length > 40) {
                throw invalid(`${id}: titles must map language codes to titles of 1-40 characters`);
            }
            copy[language] = text;
        }
        out.titles = copy;
    }
    if (icon !== undefined) {
        if (!isIcon(icon)) throw invalid(`${id}: icon must be an emoji or an image URL`);
        out.icon = icon;
    }
    if (group !== undefined) {
        if (typeof group !== 'string') throw invalid(`${id}: group must be a string`);
        out.group = (DASHBOARD_EXTENSION_GROUPS as readonly string[]).includes(group) ? group : 'system';
    }
    if (order !== undefined) {
        if (!Number.isInteger(order)) throw invalid(`${id}: order must be an integer`);
        out.order = order;
    }
    if (permission !== undefined) {
        if (typeof permission !== 'string' || permission.trim().length === 0 || permission.length > 100) throw invalid(`${id}: permission must be a permission name`);
        out.permission = permission;
    }
    if (styles !== undefined) {
        if (!Array.isArray(styles) || styles.length > 5 || !styles.every((s) => typeof s === 'string' && isUrl(s))) {
            throw invalid(`${id}: styles must be at most 5 root-relative paths or http(s) URLs`);
        }
        out.styles = [...styles];
    }
    if (version !== undefined) {
        if (typeof version !== 'string' || version.length === 0 || version.length > 50) throw invalid(`${id}: version must be 1-50 characters`);
        out.version = version;
    }
    if (pkg !== undefined && pkg !== null) {
        if (typeof pkg !== 'string' || pkg.length > 214 || !PACKAGE.test(pkg)) throw invalid(`${id}: package must be an npm package name`);
        out.package = pkg;
    }
    if (widgets !== undefined && widgets !== null) {
        if (!Array.isArray(widgets) || widgets.length > 10 || !widgets.every((w) => typeof w === 'string' && WIDGET.test(w))) {
            throw invalid(`${id}: widgets must be at most 10 slot names matching ${WIDGET.source}`);
        }
        if (widgets.length > 0) out.widgets = [...new Set(widgets)];
    }
    if (search !== undefined && search !== null) {
        if (typeof search !== 'string' || !search.startsWith('/') || search.startsWith('//') || search.length > 200 || /[\s\u0000-\u001f\u007f]/.test(search)) {
            throw invalid(`${id}: search must be a path below the page (e.g. /?q=)`);
        }
        out.search = search;
    }
    return out;
}
