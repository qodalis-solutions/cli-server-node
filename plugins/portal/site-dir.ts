import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * The plugin's package root: the nearest directory with a package.json,
 * whether this code runs compiled (dist/) or from source (tsx, vitest).
 */
function findPackageRoot(moduleDir: string): string {
    let dir = resolve(moduleDir);
    for (let i = 0; i < 3; i++) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        dir = dirname(dir);
    }
    return resolve(moduleDir);
}

/**
 * The cli-server-node checkout this package lives in (`plugins/portal` of a git working
 * copy of the server), or null for an installed package: the sibling site is looked up
 * only in a development checkout, never next to wherever a package was installed.
 */
function developmentCheckout(packageRoot: string): string | null {
    const repo = resolve(packageRoot, '..', '..');
    if (!existsSync(join(repo, '.git'))) return null;
    try {
        const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { name?: string };
        return pkg.name === '@qodalis/cli-server-node' ? repo : null;
    } catch {
        return null;
    }
}

function resolveNpmPortal(): string | null {
    try {
        const pkgPath = require.resolve('@qodalis/cli-server-portal/package.json');
        return join(dirname(pkgPath), 'dist');
    } catch {
        return null; // Package not installed
    }
}

const hasSite = (dir: string) => existsSync(join(dir, 'index.html'));

/** Where the portal site was found: `siteDir` (set with `setSiteDir`), the installed `package`, the sibling `checkout` or the `bundled` copy. */
export type PortalSiteSource = 'siteDir' | 'package' | 'checkout' | 'bundled';

/** Readable names of the sources (the `portal` command shows them). */
export const PORTAL_SITE_SOURCES: Readonly<Record<PortalSiteSource, string>> = {
    siteDir: 'setSiteDir',
    package: '@qodalis/cli-server-portal',
    checkout: 'cli-server-dashboard/portal/dist',
    bundled: 'bundled with the plugin',
};

/**
 * Resolve the portal site's directory (the one holding `index.html`) and where it was found,
 * in the .NET server's order. An explicit directory is the only candidate when given; otherwise:
 * 1. The installed `@qodalis/cli-server-portal` package (`dist/`)
 * 2. The sibling cli-server-dashboard repo's `portal/dist`, only in a development checkout
 * 3. The site bundled into this package (`site/`, copied by `npm run build` / `prepublishOnly`)
 */
export function resolvePortalSite(
    explicitDir?: string,
    moduleDir: string = __dirname,
    npmDir: () => string | null = resolveNpmPortal,
): { dir: string; source: PortalSiteSource } | null {
    if (explicitDir !== undefined) {
        return hasSite(explicitDir) ? { dir: resolve(explicitDir), source: 'siteDir' } : null;
    }
    const root = findPackageRoot(moduleDir);
    const checkout = developmentCheckout(root);
    const candidates: Array<[string | null, PortalSiteSource]> = [
        [npmDir(), 'package'],
        [checkout ? resolve(checkout, '..', 'cli-server-dashboard', 'portal', 'dist') : null, 'checkout'],
        [join(root, 'site'), 'bundled'],
    ];
    for (const [dir, source] of candidates) {
        if (dir && hasSite(dir)) return { dir: resolve(dir), source };
    }
    return null;
}

/** The portal site's directory ({@link resolvePortalSite}), or null when there is none. */
export function resolvePortalSiteDir(
    explicitDir?: string,
    moduleDir: string = __dirname,
    npmDir: () => string | null = resolveNpmPortal,
): string | null {
    return resolvePortalSite(explicitDir, moduleDir, npmDir)?.dir ?? null;
}
