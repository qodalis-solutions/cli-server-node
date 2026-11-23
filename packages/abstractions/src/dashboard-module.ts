import { createHash } from 'crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname, extname, join, resolve, sep } from 'path';
import type { CliDashboardExtension } from './dashboard-extension';

/** Where the dashboard modules of plugins are served: `/qcli/modules/<id>` (outside the API, no sign-in). */
export const DASHBOARD_MODULES_PREFIX = '/qcli/modules';

/**
 * A dashboard module a plugin serves (a page of the admin dashboard, built in the dashboard repo as
 * `@qodalis/cli-dashboard-module-<name>`): its files at `prefix`, and its extension (entry and styles
 * pointing there). `mountPlugin` registers the extension and serves the files.
 */
export interface CliDashboardModulePage {
    /** Root-relative path the files are served at, e.g. `/qcli/modules/jobs`. */
    prefix: string;
    /** Serves the files below `prefix` (GET and HEAD); anything else falls through to `next`. */
    handler: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
    extension: CliDashboardExtension;
}

/** The extension's fields the plugin gives; `entry` and `styles` come from the build. */
export type CliDashboardModuleInfo = Omit<CliDashboardExtension, 'entry' | 'styles'>;

const CONTENT_TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.wasm': 'application/wasm',
};

/**
 * The build of a module for a plugin: its copy next to the plugin (`<pluginDir>/dashboard`, or one folder up when
 * the plugin runs from `dist/`), else the installed npm package's `dist`. Undefined when neither has
 * `extension.js` (the dashboard then shows no page for it).
 *
 * @param resolveFrom the plugin's `require`, so the npm package is looked up from the plugin's own `node_modules`.
 */
export function findDashboardModule(pluginDir: string, npmPackage: string, resolveFrom?: NodeRequire): string | undefined {
    const candidates = [join(pluginDir, 'dashboard'), join(pluginDir, '..', 'dashboard')];
    try {
        const pkg = (resolveFrom ?? require).resolve(`${npmPackage}/package.json`);
        candidates.push(join(dirname(pkg), 'dist'));
    } catch {
        // Not installed
    }
    return candidates.find((dir) => existsSync(join(dir, 'extension.js')));
}

/** The first 12 hex characters of the file's SHA-256, or undefined when it does not exist. */
function fileVersion(file: string): string | undefined {
    return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12) : undefined;
}

/**
 * Serves the module built in `dir` at `prefix` (default `/qcli/modules/<id>`), with `Cache-Control: no-cache`, and
 * returns its extension: `entry` is `<prefix>/extension.js?v=<hash>` and `styles` `<prefix>/extension.css?v=<hash>`
 * when the build has a stylesheet, so a new build is fetched at once.
 */
export function dashboardModulePage(dir: string, info: CliDashboardModuleInfo, prefix = `${DASHBOARD_MODULES_PREFIX}/${info.id}`): CliDashboardModulePage {
    const root = resolve(dir);
    const js = fileVersion(join(root, 'extension.js'));
    const css = fileVersion(join(root, 'extension.css'));
    const handler: CliDashboardModulePage['handler'] = (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            next();
            return;
        }
        let relative: string;
        try {
            relative = decodeURIComponent((req.url ?? '/').split('?')[0]);
        } catch {
            next();
            return;
        }
        const file = resolve(root, `.${relative.startsWith('/') ? relative : `/${relative}`}`);
        if (!file.startsWith(root + sep) || relative.includes('\0')) {
            next();
            return;
        }
        let size: number;
        let mtime: number;
        try {
            const stat = statSync(file);
            if (!stat.isFile()) {
                next();
                return;
            }
            size = stat.size;
            mtime = stat.mtimeMs;
        } catch {
            next();
            return;
        }
        const etag = `W/"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`;
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', etag);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.headers['if-none-match'] === etag) {
            res.statusCode = 304;
            res.end();
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Content-Length', size);
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        createReadStream(file).on('error', next).pipe(res);
    };
    return {
        prefix,
        handler,
        extension: {
            ...info,
            entry: `${prefix}/extension.js${js ? `?v=${js}` : ''}`,
            ...(css ? { styles: [`${prefix}/extension.css?v=${css}`] } : {}),
        },
    };
}

/**
 * A plugin's page from its build: `dir` when given (`false` leaves the page out), else what
 * {@link findDashboardModule} finds. Undefined without a build.
 */
export function resolveDashboardModulePage(
    dir: string | false | undefined,
    found: () => string | undefined,
    info: CliDashboardModuleInfo,
    prefix?: string,
): CliDashboardModulePage | undefined {
    if (dir === false) return undefined;
    const build = dir ?? found();
    return build && existsSync(join(build, 'extension.js')) ? dashboardModulePage(build, info, prefix) : undefined;
}
