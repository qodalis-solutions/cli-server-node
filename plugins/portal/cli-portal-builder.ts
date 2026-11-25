import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import type { CliInstalledPlugin, ICliConfigProvider, ICliConfigStore, ICliModule } from '@qodalis/cli-server-abstractions';
import {
    PortalLink,
    PortalSection,
    PortalTheme,
    isValidPortalPath,
    validateFooterLinks,
    validateLogo,
    validateName,
    validateTheme,
} from './portal-options';
import { resolvePortalSite } from './site-dir';
import { portalInstalledPlugin } from './package-info';
import { cloneBranding, createPortalConfigProvider, type PortalBranding } from './portal-config-provider';
import { CliPortalCommandProcessor, type PortalStatus } from './portal-command';

export const DEFAULT_PORTAL_PATH = '/qcli/portal';
export const DEFAULT_PORTAL_NAME = 'Documentation';
export const PORTAL_SITE_NOT_FOUND = '[qcli] portal site not found; the portal is not served';

/** The site's own routes (relative to the mount): each answers the site's `index.html`. */
const SITE_ROUTES = ['/', '/guides/:slug', '/reference', '/reference/:tag'];
const BASE_TAG = /<base href="\/"\s*\/?>/;

/** The answer for a path base that would make `portal.json` URLs and `<base href>` point at another host. */
export const INVALID_PATH_BASE = 'invalid path base';

/**
 * False for a path base (the path an app is mounted under) starting with `//` or `/\\`, or
 * holding whitespace or control characters: each could point URLs at another host.
 */
export function isSafePathPrefix(prefix: string): boolean {
    // whitespace and control characters too: browsers drop them, so `/\t/host` reads as `//host`
    return !prefix.startsWith('//') && !prefix.startsWith('/\\') && !/[\s\u0000-\u001f\u007f]/.test(prefix);
}

/** The CLI's own route prefixes (core's); a portal mount must neither hold nor sit inside one. */
const CLI_PREFIXES = ['/api/qcli', '/api/v1/qcli', '/api/v2/qcli', '/api/cli', '/ws/qcli', '/ws/v1/qcli'];

/** True for a mount (other than `/`) that holds CLI routes (`/api`, `/ws`) or lies inside them. */
function holdsCliRoutes(path: string): boolean {
    if (path === '/') return false;
    const mount = path.toLowerCase();
    return CLI_PREFIXES.some((cli) => cli === mount || cli.startsWith(`${mount}/`) || mount.startsWith(`${cli}/`));
}

const escapeAttribute = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface PortalPluginResult {
    /** The mount (default `/qcli/portal`; `/` serves the portal at the root). */
    prefix: string;
    /** Only the portal's fixed paths; anything else falls through to the host. */
    router: Router;
    /** Host routes: its prefix is not a CLI route. */
    cliRoutes: false;
    /** The portal's fixed paths stay public on a protected server (`mountPlugin` reads them). */
    publicRoutes: string[];
    installedPlugin: CliInstalledPlugin;
    /** The `portal` config provider: branding changeable at runtime (`config set portal.branding.<key>`), the site read-only. */
    configProviders: ICliConfigProvider[];
    /** The `portal` terminal command (`portal [status] [--json]`, `config:read`), registered by `mountPlugin`. */
    module: ICliModule;
    /** What `portal --json` prints: the current `portal.json` (docs with its page count) and where the site is. */
    status(): PortalStatus;
}

/**
 * Fluent builder for the portal plugin: the prebuilt portal site (`@qodalis/cli-server-portal`)
 * at one mount, showing the guides of the docs plugin and the API reference of the
 * public-api plugin, with `portal.json` telling the site which sections exist.
 *
 * @example
 * ```ts
 * const portal = new CliPortalBuilder()
 *     .setName('RateBell API')
 *     .addSection(docs)
 *     .addSection(publicApi)
 *     .build();
 * mountPlugin(portal); // http://host/qcli/portal
 * ```
 */
export class CliPortalBuilder {
    private path = DEFAULT_PORTAL_PATH;
    private name = DEFAULT_PORTAL_NAME;
    private logo?: string;
    private theme?: PortalTheme;
    private readonly footerLinks: PortalLink[] = [];
    private readonly sections: Array<PortalSection & { pageCount?: number }> = [];
    private siteDir?: string;
    private configStore?: ICliConfigStore;

    /** The mount (default `/qcli/portal`); `/` mounts the portal at the root, next to the host's routes. */
    setPath(path: string): this {
        this.path = path;
        return this;
    }

    /** The site's name (default `Documentation`), 1-80 characters. */
    setName(name: string): this {
        this.name = name;
        return this;
    }

    /** An http(s) URL, a root-relative path or a base64 `data:image/…` URL. */
    setLogoUrl(url: string): this {
        this.logo = url;
        return this;
    }

    /** Mode (default `system`) and colours, with the admin dashboard's tokens. */
    setTheme(theme: PortalTheme): this {
        this.theme = theme;
        return this;
    }

    /** A footer link (at most 20): an http(s) URL or a root-relative path. */
    addFooterLink(link: PortalLink): this {
        this.footerLinks.push(link);
        return this;
    }

    /** The section of the docs or public-api plugin (its `portalSection`); one of each kind. */
    addSection(plugin: { portalSection: PortalSection; pages?: readonly unknown[] }): this {
        // the docs plugin's page count, shown by the `portal` command
        this.sections.push({ ...plugin.portalSection, ...(Array.isArray(plugin.pages) ? { pageCount: plugin.pages.length } : {}) });
        return this;
    }

    /** The site's directory (the one holding `index.html`), instead of the resolved one. */
    setSiteDir(dir: string): this {
        this.siteDir = dir;
        return this;
    }

    /**
     * Keeps the `portal` config provider's changes in `store` (its own store) instead of the server's default
     * one; the host's store for the provider's id (`config.stores`, `builder.setConfigStore(store, id)`) still wins.
     */
    setConfigStore(store: ICliConfigStore | undefined): this {
        this.configStore = store;
        return this;
    }

    /** Validates the options (startup errors are thrown here) and reads the site once. */
    build(): PortalPluginResult {
        if (!isValidPortalPath(this.path) || holdsCliRoutes(this.path)) {
            throw new Error(`invalid portal path: ${this.path}`);
        }
        const mount = this.path;
        const theme = validateTheme(this.theme);
        // The builder's branding is the default; the `portal` config provider's stored values override it (live)
        const defaults: PortalBranding = {
            name: validateName(this.name),
            logo: validateLogo(this.logo),
            themeMode: theme.mode,
            footerLinks: validateFooterLinks(this.footerLinks),
        };
        const branding = cloneBranding(defaults);
        const document = {
            docs: null as { title: string; pages: string } | null,
            api: null as { title: string; openapi: string; swagger: string } | null,
        };
        let pageCount: number | null = null;
        const seen = new Set<string>();
        for (const section of this.sections) {
            if (seen.has(section.kind)) throw new Error(`portal section already registered: ${section.kind}`);
            seen.add(section.kind);
            if (section.kind === 'docs') {
                document.docs = { title: section.title, pages: `${section.basePath}/pages` };
                pageCount = section.pageCount ?? null;
            } else if (section.kind === 'api') {
                document.api = {
                    title: section.title,
                    openapi: `${section.basePath}/openapi.json`,
                    swagger: `${section.basePath}/swagger`,
                };
            } else {
                throw new Error(`unknown portal section: ${String((section as { kind: unknown }).kind)}`);
            }
        }
        // `portal.json` for a path prefix (the app mounted under a parent path; usually ''), with the current branding
        const portalDocument = (prefix: string) => ({
            name: branding.name,
            logo: branding.logo,
            theme: { mode: branding.themeMode, dark: { ...theme.dark }, light: { ...theme.light } },
            footerLinks: branding.footerLinks.map((l) => ({ ...l })),
            docs: document.docs && { ...document.docs, pages: prefix + document.docs.pages },
            api: document.api && {
                ...document.api,
                openapi: prefix + document.api.openapi,
                swagger: prefix + document.api.swagger,
            },
        });
        const portalJsonFor = (prefix: string) => JSON.stringify(portalDocument(prefix));

        const site = resolvePortalSite(this.siteDir);
        const siteDir = site?.dir ?? null;
        const status = (): PortalStatus => {
            const json = portalDocument('');
            return {
                ...json,
                docs: json.docs && { ...json.docs, pageCount },
                site: { path: mount, found: site !== null, source: site?.source ?? null, dir: siteDir },
            };
        };

        // Only the portal's own paths, GET and HEAD; anything else falls through (the host's routes, a 404)
        const router = Router({ caseSensitive: true });
        const result: PortalPluginResult = {
            prefix: mount,
            router,
            cliRoutes: false,
            publicRoutes: [],
            installedPlugin: portalInstalledPlugin,
            configProviders: [
                createPortalConfigProvider(defaults, branding, {
                    path: mount,
                    siteFound: site !== null,
                    sections: this.sections.map((s) => s.kind),
                }).setStore(this.configStore),
            ],
            module: {
                name: 'portal',
                version: portalInstalledPlugin.version ?? '1.0.0',
                description: 'The documentation portal in the terminal: path, site, sections and branding',
                author: { name: 'Qodalis', email: 'nicolae.lupei@qodalis.com' },
                icon: '🌐',
                processors: [new CliPortalCommandProcessor(status)],
            },
            status,
        };
        if (!siteDir) {
            console.warn(PORTAL_SITE_NOT_FOUND);
            return result;
        }

        // The site's single `<base href="/" />` points at the mount (and the app's path prefix)
        const [htmlBefore, htmlAfter] = (() => {
            const source = readFileSync(join(siteDir, 'index.html'), 'utf8');
            const match = BASE_TAG.exec(source);
            return match ? [source.slice(0, match.index), source.slice(match.index + match[0].length)] : [source, undefined];
        })();
        const mountHref = mount === '/' ? '/' : `${mount}/`;
        const htmlFor = (prefix: string) =>
            htmlAfter === undefined ? htmlBefore : `${htmlBefore}<base href="${escapeAttribute(prefix + mountHref)}" />${htmlAfter}`;
        // The path the app itself is mounted under (`req.baseUrl` holds it before the portal's mount)
        const pathPrefix = (req: Request) => (mount === '/' ? req.baseUrl : req.baseUrl.slice(0, req.baseUrl.length - mount.length));
        const assetsDir = resolve(siteDir, 'assets');
        const isFileIn = (dir: string, name: string) => {
            if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) return false;
            const file = join(dir, name);
            return existsSync(file) && statSync(file).isFile();
        };

        router.get(SITE_ROUTES, (req, res) => {
            const prefix = pathPrefix(req);
            if (!isSafePathPrefix(prefix)) return void res.setHeader('Cache-Control', 'no-cache').status(400).json({ error: INVALID_PATH_BASE });
            res.setHeader('Cache-Control', 'no-cache');
            res.type('html').send(htmlFor(prefix));
        });
        router.get('/portal.json', (req, res) => {
            const prefix = pathPrefix(req);
            if (!isSafePathPrefix(prefix)) return void res.setHeader('Cache-Control', 'no-cache').status(400).json({ error: INVALID_PATH_BASE });
            res.setHeader('Cache-Control', 'no-cache');
            res.type('json').send(portalJsonFor(prefix));
        });
        router.get('/favicon.svg', (req: Request, res: Response, next: NextFunction) => {
            if (!isFileIn(siteDir, 'favicon.svg')) {
                next();
                return;
            }
            res.sendFile(join(siteDir, 'favicon.svg'), (err) => err && !res.headersSent && next());
        });
        router.get('/assets/:file', (req: Request, res: Response, next: NextFunction) => {
            const file = req.params.file;
            if (!isFileIn(assetsDir, file)) {
                next();
                return;
            }
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.sendFile(join(assetsDir, file), (err) => err && !res.headersSent && next());
        });

        // Every path under a prefix the gate opens is the portal's: its own 404, never a host
        // route behind it. At the root mount (never under /api, so nothing is opened there)
        // unknown paths keep falling through to the host.
        if (mount !== '/') {
            router.get(['/assets', '/assets/*', '/guides', '/guides/*', '/reference/*'], (_req, res) => {
                res.setHeader('Cache-Control', 'no-cache').status(404).json({ error: 'not found' });
            });
        }

        const at = (p: string) => (mount === '/' ? p : `${mount}${p}`);
        const fixed = ['', '/', '/reference', '/portal.json', '/favicon.svg'].map((p) => (p === '' ? mount : at(p)));
        // public on a protected server, under /api too (the gate never opens a CLI route this way)
        result.publicRoutes = [
            ...fixed.flatMap((p) => [`GET ${p}`, `HEAD ${p}`]),
            ...['/assets/*', '/guides/*', '/reference/*'].map((p) => `GET ${at(p)}`),
        ];
        return result;
    }
}
