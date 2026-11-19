import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import type { CliInstalledPlugin } from '@qodalis/cli-server-abstractions';
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
import { resolvePortalSiteDir } from './site-dir';
import { portalInstalledPlugin } from './package-info';

export const DEFAULT_PORTAL_PATH = '/qcli/portal';
export const DEFAULT_PORTAL_NAME = 'Documentation';
export const PORTAL_SITE_NOT_FOUND = '[qcli] portal site not found; the portal is not served';

/** The site's own routes (relative to the mount): each answers the site's `index.html`. */
const SITE_ROUTES = ['/', '/guides/:slug', '/reference', '/reference/:tag'];
const BASE_TAG = /<base href="\/"\s*\/?>/;

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
    private readonly sections: PortalSection[] = [];
    private siteDir?: string;

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
    addSection(plugin: { portalSection: PortalSection }): this {
        this.sections.push(plugin.portalSection);
        return this;
    }

    /** The site's directory (the one holding `index.html`), instead of the resolved one. */
    setSiteDir(dir: string): this {
        this.siteDir = dir;
        return this;
    }

    /** Validates the options (startup errors are thrown here) and reads the site once. */
    build(): PortalPluginResult {
        if (!isValidPortalPath(this.path)) {
            throw new Error(`invalid portal path: ${this.path}`);
        }
        const mount = this.path;
        const document = {
            name: validateName(this.name),
            logo: validateLogo(this.logo),
            theme: validateTheme(this.theme),
            footerLinks: validateFooterLinks(this.footerLinks),
            docs: null as { title: string; pages: string } | null,
            api: null as { title: string; openapi: string; swagger: string } | null,
        };
        const seen = new Set<string>();
        for (const section of this.sections) {
            if (seen.has(section.kind)) throw new Error(`portal section already registered: ${section.kind}`);
            seen.add(section.kind);
            if (section.kind === 'docs') {
                document.docs = { title: section.title, pages: `${section.basePath}/pages` };
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
        const portalJson = JSON.stringify(document);

        // Only the portal's own paths, GET and HEAD; anything else falls through (the host's routes, a 404)
        const router = Router({ caseSensitive: true });
        const result: PortalPluginResult = {
            prefix: mount,
            router,
            cliRoutes: false,
            publicRoutes: [],
            installedPlugin: portalInstalledPlugin,
        };
        const siteDir = resolvePortalSiteDir(this.siteDir);
        if (!siteDir) {
            console.warn(PORTAL_SITE_NOT_FOUND);
            return result;
        }

        const html = readFileSync(join(siteDir, 'index.html'), 'utf8').replace(BASE_TAG, `<base href="${mount === '/' ? '/' : `${mount}/`}" />`);
        const assetsDir = resolve(siteDir, 'assets');
        const isFileIn = (dir: string, name: string) => {
            if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) return false;
            const file = join(dir, name);
            return existsSync(file) && statSync(file).isFile();
        };

        router.get(SITE_ROUTES, (_req, res) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.type('html').send(html);
        });
        router.get('/portal.json', (_req, res) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.type('json').send(portalJson);
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

        const at = (p: string) => (mount === '/' ? p : `${mount}${p}`);
        const fixed = ['', '/', '/reference', '/portal.json', '/favicon.svg'].map((p) => (p === '' ? mount : at(p)));
        result.publicRoutes = fixed.flatMap((p) => [`GET ${p}`, `HEAD ${p}`]);
        return result;
    }
}
