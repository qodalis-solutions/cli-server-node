import { existsSync } from 'fs';
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

function resolveNpmPortal(): string | null {
    try {
        const pkgPath = require.resolve('@qodalis/cli-server-portal/package.json');
        return join(dirname(pkgPath), 'dist');
    } catch {
        return null; // Package not installed
    }
}

const hasSite = (dir: string) => existsSync(join(dir, 'index.html'));

/**
 * Resolve the portal site's directory (the one holding `index.html`). An explicit
 * directory is the only candidate when given; otherwise, in order:
 * 1. The sibling cli-server-dashboard repo's `portal/dist` (development), so a fresh build is served
 * 2. The site bundled into this package (`site/`, copy-portal)
 * 3. ../cli-server-dashboard/portal/dist relative to the working directory
 * 4. @qodalis/cli-server-portal/dist (npm package)
 */
export function resolvePortalSiteDir(
    explicitDir?: string,
    moduleDir: string = __dirname,
    cwd: string = process.cwd(),
): string | null {
    if (explicitDir !== undefined) {
        return hasSite(explicitDir) ? resolve(explicitDir) : null;
    }
    const root = findPackageRoot(moduleDir);
    const candidates = [
        resolve(root, '..', '..', '..', 'cli-server-dashboard', 'portal', 'dist'),
        join(root, 'site'),
        resolve(cwd, '..', 'cli-server-dashboard', 'portal', 'dist'),
        resolveNpmPortal(),
    ];
    for (const dir of candidates) {
        if (dir && hasSite(dir)) return resolve(dir);
    }
    return null;
}
