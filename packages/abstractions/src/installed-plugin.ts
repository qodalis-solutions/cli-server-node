import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * A server plugin package the host installed (users, admin, jobs, a storage
 * provider, ...), as listed by the admin dashboard's plugins page
 * (`GET /api/v1/qcli/plugins/installed`). Read from the package's `package.json`.
 */
export interface CliInstalledPlugin {
    /** The npm package name, e.g. `@qodalis/cli-server-plugin-users`. */
    id: string;
    /** A short name, e.g. `Users` or `FileSystem.Json`. */
    name: string;
    /** The package version. */
    version?: string;
    /** The package description. */
    description?: string;
}

/**
 * Key under which a module, provider or plugin result carries the
 * {@link CliInstalledPlugin} of its package (on the object or its class), so the
 * server lists the package when it is added. A global symbol: copies of this
 * package installed side by side agree on it.
 */
export const CLI_INSTALLED_PLUGIN: unique symbol = Symbol.for('qodalis.cli.installedPlugin');

const PLUGIN_PREFIX = 'cli-server-plugin-';

/**
 * The default short name of a package: the name without its scope and the
 * `cli-server-plugin-` prefix, each dash-separated word capitalized and joined
 * with dots (`@acme/cli-server-plugin-billing-sync` -> `Billing.Sync`).
 */
export function installedPluginName(id: string): string {
    let name = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
    if (name.startsWith(PLUGIN_PREFIX) && name.length > PLUGIN_PREFIX.length) {
        name = name.slice(PLUGIN_PREFIX.length);
    }
    return name
        .split('-')
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('.');
}

/**
 * Describes the package a file or directory belongs to: walks up from `from`
 * (typically `__dirname`) to the nearest `package.json`, or to the one named
 * `packageName` when given, and reads its name, version and description.
 * Returns `undefined` when no such `package.json` is found.
 *
 * @param from - A directory (or a `package.json` path) inside the package.
 * @param packageName - The package's name, to skip `package.json` files of other packages on the way up.
 * @param name - The short name; default {@link installedPluginName} of the package name.
 */
export function readInstalledPlugin(from: string, packageName?: string, name?: string): CliInstalledPlugin | undefined {
    let dir = from.endsWith('package.json') ? dirname(from) : from;
    for (;;) {
        const file = join(dir, 'package.json');
        if (existsSync(file)) {
            try {
                const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string; description?: string };
                if (pkg.name && (!packageName || pkg.name === packageName)) {
                    return {
                        id: pkg.name,
                        name: name ?? installedPluginName(pkg.name),
                        version: pkg.version,
                        description: pkg.description,
                    };
                }
            } catch {
                // An unreadable package.json: keep looking further up
            }
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** The {@link CliInstalledPlugin} a value (or its class) carries under {@link CLI_INSTALLED_PLUGIN}, if any. */
export function installedPluginOf(value: unknown): CliInstalledPlugin | undefined {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const own = (value as Record<symbol, unknown>)[CLI_INSTALLED_PLUGIN];
    const fromClass = (value as { constructor?: Record<symbol, unknown> }).constructor?.[CLI_INSTALLED_PLUGIN];
    const plugin = own ?? fromClass;
    return isInstalledPlugin(plugin) ? plugin : undefined;
}

function isInstalledPlugin(value: unknown): value is CliInstalledPlugin {
    const p = value as Partial<CliInstalledPlugin> | undefined;
    return !!p && typeof p.id === 'string' && typeof p.name === 'string';
}
