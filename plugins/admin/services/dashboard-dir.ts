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

function resolveNpmDashboard(): string | null {
    try {
        const pkgPath = require.resolve('@qodalis/cli-server-dashboard/package.json');
        return join(dirname(pkgPath), 'dist');
    } catch {
        return null; // Package not installed
    }
}

/**
 * Resolve the dashboard dist directory. Looks for:
 * 1. The explicitly set path
 * 2. The sibling cli-server-dashboard repo (development), so a fresh build is served
 * 3. The dashboard bundled into this package (copy-dashboard)
 * 4. ../cli-server-dashboard/dist relative to the working directory
 * 5. @qodalis/cli-server-dashboard/dist (npm package)
 */
export function resolveDashboardDir(
    explicitDir?: string,
    moduleDir: string = __dirname,
    cwd: string = process.cwd(),
): string | null {
    const root = findPackageRoot(moduleDir);
    const candidates = [
        explicitDir,
        resolve(root, '..', '..', '..', 'cli-server-dashboard', 'dist'),
        join(root, 'dashboard'),
        resolve(cwd, '..', 'cli-server-dashboard', 'dist'),
        resolveNpmDashboard(),
    ];

    for (const dir of candidates) {
        if (dir && existsSync(join(dir, 'index.html'))) return resolve(dir);
    }
    return null;
}
