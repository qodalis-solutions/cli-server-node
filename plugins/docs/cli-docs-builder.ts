import { Router, Request } from 'express';
import type { CliInstalledPlugin } from '@qodalis/cli-server-abstractions';
import { DocsPage, VARIABLE_KEY, comparePages, isValidSlug, parsePage, readFolder, replaceVariables } from './docs-pages';
import { docsInstalledPlugin } from './package-info';

export const DEFAULT_DOCS_BASE_PATH = '/qcli/docs';
export const DEFAULT_DOCS_TITLE = 'Guides';
export const DEFAULT_DOCS_NAME = 'Documentation';
export const PAGE_NOT_FOUND = 'page not found';

const BUILT_IN_VARIABLES = new Set(['baseUrl', 'name']);

/** Where the portal finds this plugin's section (`new CliPortalBuilder().addSection(docs)`). */
export interface DocsPortalSection {
    kind: 'docs';
    title: string;
    basePath: string;
}

export interface DocsPluginResult {
    /** The base path (default `/qcli/docs`). */
    prefix: string;
    /** `GET /pages` and `GET /pages/:slug`. */
    router: Router;
    /** Host routes: its prefix is not a CLI route. */
    cliRoutes: false;
    /** The pages stay public on a protected server (`mountPlugin` reads them). */
    publicRoutes: string[];
    /** The pages in page order, as written (variables not replaced). */
    pages: DocsPage[];
    /** Read by the portal plugin. */
    portalSection: DocsPortalSection;
    installedPlugin: CliInstalledPlugin;
}

/** True for `/segment[/segment...]`: starts with `/`, no trailing `/`, not `/` itself. */
function isValidBasePath(path: unknown): path is string {
    return typeof path === 'string' && /^(\/[A-Za-z0-9._~-]+)+$/.test(path);
}

type Source = { folder: string } | { slug: string; markdown: string };

/**
 * Fluent builder for the docs plugin: markdown guides from folders or code, served as JSON
 * (the portal plugin shows them). Front matter (`title`, `group`, `order`) and
 * `{{ variables }}` (`baseUrl`, `name` and the host's) are handled by the plugin; the
 * markdown is rendered by the site.
 *
 * @example
 * ```ts
 * const docs = new CliDocsBuilder()
 *     .setName('RateBell API')
 *     .setVariable('support', 'help@ratebell.app')
 *     .addFolder('docs')
 *     .build();
 * mountPlugin(docs);
 * ```
 */
export class CliDocsBuilder {
    private basePath = DEFAULT_DOCS_BASE_PATH;
    private title = DEFAULT_DOCS_TITLE;
    private name = DEFAULT_DOCS_NAME;
    private baseUrl?: string;
    private readonly variables: Array<[string, string]> = [];
    private readonly sources: Source[] = [];

    /** Where the pages are served (default `/qcli/docs`). */
    setBasePath(path: string): this {
        this.basePath = path;
        return this;
    }

    /** The portal's label for the guides (default `Guides`). */
    setTitle(title: string): this {
        this.title = title;
        return this;
    }

    /** The `{{name}}` variable (default `Documentation`). */
    setName(name: string): this {
        this.name = name;
        return this;
    }

    /** The `{{baseUrl}}` variable (default: the request's `scheme://host`). */
    setBaseUrl(url: string): this {
        this.baseUrl = url.replace(/\/+$/, '');
        return this;
    }

    /** A host variable, `{{key}}` in titles and pages (`baseUrl` and `name` are built in). */
    setVariable(key: string, value: string): this {
        this.variables.push([key, String(value)]);
        return this;
    }

    /** Every `*.md` file directly in the folder (relative to the working directory), read by `build()`. */
    addFolder(path: string): this {
        this.sources.push({ folder: path });
        return this;
    }

    /** A page in code; front matter works as in files. */
    addPage(slug: string, markdown: string): this {
        this.sources.push({ slug, markdown });
        return this;
    }

    /** Reads the folders and validates everything; startup errors are thrown here. */
    build(): DocsPluginResult {
        if (!isValidBasePath(this.basePath)) {
            throw new Error(`invalid docs base path: ${this.basePath}`);
        }
        const hostVariables = new Map<string, string>();
        for (const [key, value] of this.variables) {
            if (BUILT_IN_VARIABLES.has(key)) throw new Error(`docs variable is built in: ${key}`);
            if (!VARIABLE_KEY.test(key)) throw new Error(`invalid docs variable: ${key}`);
            hostVariables.set(key, value);
        }

        const pages: DocsPage[] = [];
        const seen = new Set<string>();
        const add = (page: DocsPage) => {
            if (seen.has(page.slug)) throw new Error(`duplicate docs page: ${page.slug}`);
            seen.add(page.slug);
            pages.push(page);
        };
        for (const source of this.sources) {
            if ('folder' in source) {
                readFolder(source.folder).forEach(add);
            } else {
                if (!isValidSlug(source.slug)) throw new Error(`invalid docs page slug: ${source.slug}`);
                add(parsePage(source.slug, String(source.markdown ?? '')));
            }
        }
        pages.sort(comparePages);
        const bySlug = new Map(pages.map((p) => [p.slug, p]));

        const basePath = this.basePath;
        const name = this.name;
        const baseUrl = this.baseUrl;
        const variablesFor = (req: Request) =>
            new Map<string, string>([
                ...hostVariables,
                ['baseUrl', baseUrl ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`],
                ['name', name],
            ]);

        // No sign-in, credentials ignored
        const router = Router();
        router.get('/pages', (req, res) => {
            const variables = variablesFor(req);
            res.setHeader('Cache-Control', 'no-cache');
            res.json(pages.map((p) => ({ slug: p.slug, title: replaceVariables(p.title, variables), group: p.group, order: p.order })));
        });
        router.get('/pages/:slug', (req, res) => {
            const page = bySlug.get(req.params.slug);
            if (!page) {
                res.status(404).json({ error: PAGE_NOT_FOUND });
                return;
            }
            const variables = variablesFor(req);
            res.setHeader('Cache-Control', 'no-cache');
            res.json({
                slug: page.slug,
                title: replaceVariables(page.title, variables),
                group: page.group,
                order: page.order,
                markdown: replaceVariables(page.markdown, variables),
            });
        });

        const publicPaths = ['/pages', ...pages.map((p) => `/pages/${p.slug}`)];
        return {
            prefix: basePath,
            router,
            cliRoutes: false,
            publicRoutes: publicPaths.flatMap((p) => [`GET ${basePath}${p}`, `HEAD ${basePath}${p}`]),
            pages,
            portalSection: { kind: 'docs', title: this.title, basePath },
            installedPlugin: docsInstalledPlugin,
        };
    }
}
