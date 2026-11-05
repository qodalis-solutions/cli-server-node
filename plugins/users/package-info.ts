import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * A server plugin package, as listed among the server's installed plugins
 * (same shape as `CliInstalledPlugin` of `@qodalis/cli-server-abstractions`,
 * which this package does not depend on).
 */
export interface CliInstalledPlugin {
    id: string;
    name: string;
    version?: string;
    description?: string;
}

const PACKAGE_NAME = '@qodalis/cli-server-plugin-users';

function readPackage(): { version?: string; description?: string } {
    for (let dir = __dirname; ; dir = dirname(dir)) {
        const file = join(dir, 'package.json');
        if (existsSync(file)) {
            try {
                const pkg = JSON.parse(readFileSync(file, 'utf8'));
                if (pkg.name === PACKAGE_NAME) return pkg;
            } catch {
                // keep looking further up
            }
        }
        if (dirname(dir) === dir) return {};
    }
}

const pkg = readPackage();

/** This package, as listed among the server's installed plugins. */
export const usersInstalledPlugin: CliInstalledPlugin = {
    id: PACKAGE_NAME,
    name: 'Users',
    version: pkg.version,
    description: pkg.description,
};
