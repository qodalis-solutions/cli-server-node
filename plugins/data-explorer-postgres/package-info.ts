import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

// Declared here rather than imported, so the package builds and runs against earlier
// @qodalis/cli-server-abstractions versions (same global symbol and shape as there).

/** Key under which a class carries the package it belongs to (`CLI_INSTALLED_PLUGIN`). */
export const CLI_INSTALLED_PLUGIN: unique symbol = Symbol.for('qodalis.cli.installedPlugin');

/** A server plugin package, as listed among the server's installed plugins (`CliInstalledPlugin`). */
export interface CliInstalledPlugin {
    id: string;
    name: string;
    version?: string;
    description?: string;
}

const PACKAGE_NAME = '@qodalis/cli-server-plugin-data-explorer-postgres';

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
export const dataExplorerPostgresInstalledPlugin: CliInstalledPlugin = {
    id: PACKAGE_NAME,
    name: 'DataExplorer.Postgres',
    version: pkg.version,
    description: pkg.description,
};
