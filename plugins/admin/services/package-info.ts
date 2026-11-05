import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * A server plugin package, as listed among the server's installed plugins
 * (same shape as `CliInstalledPlugin` of `@qodalis/cli-server-abstractions`;
 * declared here so the plugin works with earlier abstractions versions).
 */
export interface CliInstalledPlugin {
    id: string;
    name: string;
    version?: string;
    description?: string;
}

const PACKAGE_NAME = '@qodalis/cli-server-plugin-admin';

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
export const adminInstalledPlugin: CliInstalledPlugin = {
    id: PACKAGE_NAME,
    name: 'Admin',
    version: pkg.version,
    description: pkg.description,
};
