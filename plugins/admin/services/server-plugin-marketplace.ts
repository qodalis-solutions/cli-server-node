import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { mkdir, rename, rm, writeFile } from 'fs/promises';
import { createRequire } from 'module';
import { dirname, join, resolve, sep } from 'path';
import { gunzipSync } from 'zlib';
import type { CliInstalledPlugin, CliServerPluginRecord, CliServerPluginState, ICliServerPlugins, ICliServerRestart } from '@qodalis/cli-server-abstractions';
import {
    DEFAULT_MARKETPLACE_URL,
    DashboardMarketplaceActor,
    DashboardMarketplaceAuditEntry,
    DashboardMarketplaceError,
    DashboardInstallPolicy,
    MARKETPLACE_API_PATH,
    MarketplaceFetch,
    MarketplaceFetchResponse,
    compareDashboardPluginVersions,
} from './dashboard-marketplace';
import { DATA_DIR_HINT, pluginsFolderError } from './plugins-folder';

/** This server's platform in the marketplace (`platforms.node`). */
export const SERVER_PLUGIN_PLATFORM = 'node';
/** The platforms a server plugin may have a package for. */
export const SERVER_PLUGIN_PLATFORMS: readonly string[] = ['node', 'python', 'dotnet'];
/**
 * What `search` lists: `this` (default) this server's platform, `all` every server plugin, or one platform's (the
 * marketplace's `platform` filter).
 */
export const SERVER_PLUGIN_PLATFORM_FILTERS: readonly string[] = ['this', 'all', ...SERVER_PLUGIN_PLATFORMS];
/** The permission to install, update and remove server plugins. */
export const PLUGINS_INSTALL_PERMISSION = 'plugins:install';
/** The npm registry tarballs and their integrity come from. */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
/** The largest tarball accepted. */
export const SERVER_PLUGIN_MAX_TARBALL_BYTES = 50 * 1024 * 1024;
/** The server package whose version this server reports (every server package shares one version). */
export const SERVER_CORE_PACKAGE = '@qodalis/cli-server-node';
/** The packages a plugin's `serverRange` may be on (as the marketplace reads it: the core, then the abstractions). */
export const SERVER_CORE_PACKAGES: readonly string[] = ['@qodalis/cli-server-node', '@qodalis/cli-server-abstractions'];
/** Published when a server plugin is installed, updated or removed (audience `admin:access`). */
export const SERVER_PLUGINS_CHANGED_EVENT = 'server:plugins-changed';

/** The server marketplace's options (the admin plugin's `setMarketplace`, shared with dashboard plugins). */
export interface ServerPluginMarketplaceOptions {
    url?: string;
    install?: DashboardInstallPolicy;
    fetch?: MarketplaceFetch;
    timeoutMs?: number;
    /** The npm registry (default `https://registry.npmjs.org`). */
    npmRegistry?: string;
    /** The dependencies a plugin may bring when the marketplace pins none: names, `@scope/*` or `prefix*` (default none). */
    trustedDependencies?: string[];
    /** The version of a package the server resolves (default {@link defaultHostPackageVersion}). */
    hostPackageVersion?: (name: string) => string | undefined;
}

/** A dependency the marketplace pins for a version: exactly this version, this tarball (npm's sha512). */
export interface MarketplaceDependencyPin {
    id: string;
    version: string;
    integrity: string;
    /** The range the plugin (or another dependency) asks for; informative. */
    range?: string;
}

/** True when `name` is allowed by a pattern: the name itself, `@scope/*`, or `prefix*`. */
export function isTrustedDependency(name: string, patterns: readonly string[]): boolean {
    return patterns.some((raw) => {
        const pattern = raw.trim();
        if (!pattern) return false;
        if (pattern === '*') return true;
        if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
        return name === pattern;
    });
}

const hostRequires = (): NodeRequire[] => {
    const list: NodeRequire[] = [require];
    try {
        list.push(createRequire(join(process.cwd(), 'package.json')));
    } catch {
        // no working directory
    }
    if (require.main) list.push(require.main.require.bind(require.main) as NodeRequire);
    return list;
};

/**
 * The version of `name` the server resolves (from the admin plugin's own folder, the working directory, the main
 * module), read from its package.json; undefined when the server has none.
 */
export function defaultHostPackageVersion(name: string): string | undefined {
    for (const req of hostRequires()) {
        try {
            const pkg = req(`${name}/package.json`) as { name?: string; version?: string };
            if (pkg?.name === name && typeof pkg.version === 'string') return pkg.version;
        } catch {
            // not exported or not there: from its main file up to its package.json
        }
        try {
            let dir = dirname(req.resolve(name));
            for (;;) {
                const file = join(dir, 'package.json');
                if (existsSync(file)) {
                    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
                    if (pkg.name === name && typeof pkg.version === 'string') return pkg.version;
                }
                const up = dirname(dir);
                if (up === dir) break;
                dir = up;
            }
        } catch {
            // not resolvable from there
        }
    }
    return undefined;
}

/** A dependency resolved for an install: its tarball checked against its integrity. */
interface ResolvedDependency {
    id: string;
    version: string;
    integrity: string;
    source: 'pinned' | 'trusted';
    bytes: Uint8Array;
}

export interface ServerPluginMarketplaceDeps {
    /** The server's runtime plugins (`builder.serverPlugins`): the installed list and what this process loaded. */
    plugins: ICliServerPlugins;
    /** Every installed package (the host's and the marketplace's), for clashes and the server's version. */
    installedPlugins: () => ReadonlyArray<CliInstalledPlugin>;
    /** The server's restart service: every change is marked as needing a restart. */
    restart?: ICliServerRestart;
    audit?: () => ((entry: DashboardMarketplaceAuditEntry) => Promise<void>) | undefined;
    publish?: (type: string, data: Record<string, unknown>) => void;
    /** What to do when the plugins folder cannot be written (default: set `dataDir` or `QCLI_DATA_DIR`). */
    folderHint?: string;
}

/**
 * A version of a platform's package, as the marketplace lists it: the plugin's `versions` hold every platform's,
 * each with its `platform` (its id in the marketplace's version routes is `<platform>:<version>`).
 */
export interface MarketplaceServerVersion {
    version: string;
    platform?: string;
    package?: string;
    registry?: string;
    status?: string;
    publishedAt?: string;
    /** The range of `@qodalis/cli-server-node` the version needs. */
    serverRange?: string | null;
    /** `sha512-…` (npm's `dist.integrity`). */
    integrity?: string | null;
    autoInstall?: boolean;
    autoInstallReason?: string;
    /**
     * The version's dependencies pinned by the marketplace (the whole tree the server may lack): installed exactly,
     * each checked against its sha512; a dependency without a pin is refused. Absent: the server's `trustedDependencies`.
     */
    dependencies?: MarketplaceDependencyPin[];
    [key: string]: unknown;
}

/** One platform's package of a server plugin (`platforms.node` of an item: `{ package, registry, latest, install }`). */
export interface MarketplaceServerPlatform {
    platform?: string;
    package: string;
    registry?: string;
    latest?: string | null;
    /** The install command (`npm install …`). */
    install?: string;
    serverRange?: string | null;
    autoInstall?: boolean;
    autoInstallReason?: string;
    versions?: MarketplaceServerVersion[];
    [key: string]: unknown;
}

/** A server plugin as the marketplace lists it (its fields passed through, the annotations added). */
export interface MarketplaceServerItem {
    name: string;
    kind?: string;
    title?: string;
    description?: string;
    icon?: string;
    publisher?: { name?: string; verified?: boolean };
    platforms?: Record<string, MarketplaceServerPlatform> | MarketplaceServerPlatform[];
    /** Every platform's versions (details), each with its `platform`. */
    versions?: MarketplaceServerVersion[];
    /** With `platform=`: that platform's newest listed version (for `serverVersion` when given), else null. */
    latest?: string | null;
    version?: string | null;
    /** With `platform=`: whether a version runs on the given `serverVersion`, and why not. */
    compatible?: boolean;
    reason?: string;
    autoInstall?: boolean;
    autoInstallReason?: string;
    [key: string]: unknown;
}

/** The annotations this server adds to a server plugin. */
export interface ServerPluginAnnotations {
    /** This server's platform: its package, the newest version it can install, the installed one, whether it runs here. */
    platform: { package: string; latest: string | null; installed: string | null; compatible: boolean; reason?: string } | null;
    /** The other platforms with a package (`['python', 'dotnet']`). */
    otherPlatforms: string[];
    /** False when the plugin needs the host's code (`autoInstall: false`): listed, never installed here. */
    autoInstall: boolean;
    autoInstallReason?: string;
    /**
     * `source: 'marketplace'`: installed from the marketplace (update and remove it here); `'code'`: the host adds
     * this platform's package in its code (its version, null when unknown): never installed, updated or removed here.
     */
    installed: { version: string | null; source: 'code' | 'marketplace' } | null;
    /** The marketplace has a newer compatible version than the installed one (for `source: 'code'`, to update in code). */
    updateAvailable: boolean;
    allowed: boolean;
    blockedReason?: string;
}

/** An installed server plugin as `GET /installed` lists it. */
export interface InstalledServerPlugin {
    name: string;
    package: string;
    version: string;
    title: string;
    icon: string | null;
    description: string | null;
    installedAt: string;
    installedBy: string;
    /**
     * `loaded`: running this version; `pending`: installed or updated, running after a restart; `failed`: the last
     * start could not load it (`error`); `needs-configuration`: loaded without registering anything, its required
     * settings (`missing`) have no value (save them, then restart); `skipped`: the host installed the same package;
     * `removed`: removed, still running until a restart.
     */
    status: 'loaded' | 'pending' | 'needs-configuration' | 'failed' | 'skipped' | 'removed';
    /** The version this process runs, null when none. */
    loadedVersion: string | null;
    error?: string;
    /** `needs-configuration`: the settings it needs (`<section>.<key>`) or the reason. */
    missing?: string[];
    /** Its settings provider (`GET /api/v1/qcli/config/<id>`, `config get <id>`), once it registered one. */
    settings?: string;
    updateAvailable?: boolean;
}

/** What an install, update or removal answers (202). */
export type ServerPluginChangeResult = InstalledServerPlugin & { restartRequired: boolean; changed?: boolean; previousVersion?: string };

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/** True for a marketplace plugin id (`jobs`) or an npm package name. */
export function isValidServerPluginName(name: unknown): name is string {
    return typeof name === 'string' && name.length <= 214 && (PLUGIN_ID.test(name) || NPM_NAME.test(name));
}

const isPackage = (name: unknown): name is string => typeof name === 'string' && name.length <= 214 && NPM_NAME.test(name);
const isVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && SEMVER.test(v);

/** `sha512-<base64>` of the bytes (npm's `dist.integrity`). */
export function sha512Integrity(bytes: Uint8Array): string {
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

// ------------------------------------------------------------------------ semver ranges

/** `1`, `1.2`, `1.x`, `1.2.3-beta.1` -> its parts; undefined for anything else. */
function partial(text: string): { major: number; minor?: number; patch?: number; pre?: string } | undefined {
    const m = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-.]+))?$/.exec(text);
    if (!m) return undefined;
    const num = (s: string | undefined) => (s === undefined || /^[xX*]$/.test(s) ? undefined : Number(s));
    const minor = num(m[2]);
    const patch = minor === undefined ? undefined : num(m[3]);
    return { major: Number(m[1]), minor, patch, pre: m[4] };
}

const versionOf = (p: { major: number; minor?: number; patch?: number; pre?: string }) => `${p.major}.${p.minor ?? 0}.${p.patch ?? 0}${p.pre ? `-${p.pre}` : ''}`;

/** One comparator set (`>=1.2.0 <2.0.0-0`) as tests on a version. */
function comparators(set: string): Array<(v: string) => boolean> | undefined {
    const tests: Array<(v: string) => boolean> = [];
    const cmp = compareDashboardPluginVersions;
    for (const token of set.split(/\s+/).filter(Boolean)) {
        if (token === '*' || token === 'x' || token === 'X') continue;
        const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)!;
        const op = m[1] ?? '';
        const p = partial(m[2]);
        if (!p) return undefined;
        const low = versionOf(p);
        let high: string | undefined;
        if (op === '^') {
            if (p.major > 0 || p.minor === undefined) high = `${p.major + 1}.0.0-0`;
            else if (p.minor > 0 || p.patch === undefined) high = `0.${p.minor + 1}.0-0`;
            else high = `0.0.${p.patch + 1}-0`;
        } else if (op === '~') {
            high = p.minor === undefined ? `${p.major + 1}.0.0-0` : `${p.major}.${p.minor + 1}.0-0`;
        } else if (op === '' || op === '=') {
            if (p.minor === undefined) high = `${p.major + 1}.0.0-0`;
            else if (p.patch === undefined) high = `${p.major}.${p.minor + 1}.0-0`;
            else {
                tests.push((v) => cmp(v, low) === 0);
                continue;
            }
        }
        if (op === '>') tests.push((v) => cmp(v, low) > 0);
        else if (op === '<') tests.push((v) => cmp(v, low) < 0);
        else if (op === '<=') tests.push((v) => cmp(v, low) <= 0);
        else tests.push((v) => cmp(v, low) >= 0);
        if (high) {
            const h = high;
            tests.push((v) => cmp(v, h) < 0);
        }
    }
    return tests;
}

/**
 * True when `version` is in the npm range (`^1.0.0-beta.29`, `>=1.0.0 <2`, `1.x || 2.x`, `*`). Prereleases are
 * compared like releases (an npm range would leave out prereleases of other versions: the server's own versions are
 * prereleases). An empty or absent range accepts every version; a range it cannot read accepts none.
 */
export function satisfiesServerRange(version: string, range: string | null | undefined): boolean {
    const text = (range ?? '').trim();
    if (!text || text === '*' || text === 'latest') return true;
    if (!isVersion(version)) return false;
    return text.split('||').some((set) => {
        const normalized = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
        const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(normalized);
        const tests = comparators(hyphen ? `>=${hyphen[1]} <=${hyphen[2]}` : normalized);
        return !!tests && tests.every((t) => t(version));
    });
}

// ------------------------------------------------------------------------ tarballs

/**
 * The files of an npm tarball (gzip'd ustar, with GNU long names and pax paths), at most `limit` bytes unpacked.
 * Only regular files; names as stored (`package/package.json`).
 */
export function readTarballFiles(tgz: Uint8Array, limit = 200 * 1024 * 1024): Map<string, Buffer> {
    const tar = gunzipSync(tgz, { maxOutputLength: limit });
    const files = new Map<string, Buffer>();
    const text = (start: number, length: number) => {
        const slice = tar.subarray(start, start + length);
        const end = slice.indexOf(0);
        return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
    };
    let offset = 0;
    let nextName: string | undefined;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        let name = text(offset, 100);
        const magic = text(offset + 257, 6);
        const prefix = magic.startsWith('ustar') ? text(offset + 345, 155) : '';
        if (prefix) name = `${prefix}/${name}`;
        const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
        if (!Number.isFinite(size) || size < 0) throw new Error('invalid tarball');
        const type = String.fromCharCode(header[156] || 48);
        const start = offset + 512;
        const body = tar.subarray(start, start + size);
        if (type === 'L') {
            nextName = body.toString('utf8').replace(/\0+$/, '');
        } else if (type === 'x') {
            const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
            if (path) nextName = path[1];
        } else if (type === 'g') {
            // Global pax header: nothing needed
        } else {
            if (type === '0' || type === '\0' || type === '7') files.set(nextName ?? name, Buffer.from(body));
            nextName = undefined;
        }
        offset = start + Math.ceil(size / 512) * 512;
    }
    return files;
}

/** The folder every file of an npm tarball is under. */
const TARBALL_ROOT = 'package/';

/**
 * The files of an npm tarball, every one under `package/` (names as stored). Throws 502 `invalid tarball` when it
 * cannot be read, `invalid tarball: <name>` for a file outside `package/`: `tarballPackageJson` reads
 * `package/package.json` and `unpackTarball` writes the folder's content, so another top folder could replace it.
 */
function tarballPackageFiles(tgz: Uint8Array): Map<string, Buffer> {
    let files: Map<string, Buffer>;
    try {
        files = readTarballFiles(tgz);
    } catch {
        throw new DashboardMarketplaceError(502, 'invalid tarball');
    }
    for (const name of files.keys()) {
        if (!name.startsWith(TARBALL_ROOT)) throw new DashboardMarketplaceError(502, `invalid tarball: ${name.slice(0, 200)} is outside package/`);
    }
    return files;
}

/** The `package.json` of an npm tarball (`package/package.json`). Throws when there is none or a file is outside `package/`. */
export function tarballPackageJson(tgz: Uint8Array): Record<string, unknown> {
    const files = tarballPackageFiles(tgz);
    const raw = files.get(`${TARBALL_ROOT}package.json`);
    if (!raw) throw new DashboardMarketplaceError(502, 'invalid tarball: no package/package.json');
    try {
        return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
        throw new DashboardMarketplaceError(502, 'invalid tarball: package.json is not JSON');
    }
}

/**
 * Writes an npm tarball's files into `dir` (the content of its `package/` folder; a file outside it refuses the
 * whole tarball before anything is written), each kept inside it. No scripts run.
 */
export async function unpackTarball(tgz: Uint8Array, dir: string): Promise<void> {
    const files = tarballPackageFiles(tgz);
    const root = resolve(dir);
    const targets: Array<[string, Buffer]> = [];
    for (const [name, content] of files) {
        const relative = name.slice(TARBALL_ROOT.length);
        if (!relative) continue;
        const path = resolve(root, relative);
        if (!path.startsWith(root + sep)) throw new DashboardMarketplaceError(502, `invalid tarball: ${name}`);
        targets.push([path, content]);
    }
    for (const [path, content] of targets) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
    }
}

// ------------------------------------------------------------------------ the service

/** The platforms of an item: `{ node: {...}, python: {...} }` from either form. */
function platformsOf(item: MarketplaceServerItem): Record<string, MarketplaceServerPlatform> {
    const out: Record<string, MarketplaceServerPlatform> = {};
    const raw = item.platforms;
    if (Array.isArray(raw)) {
        for (const p of raw) if (p && typeof p.platform === 'string' && typeof p.package === 'string') out[p.platform] = p;
    } else if (raw && typeof raw === 'object') {
        for (const [key, p] of Object.entries(raw)) if (p && typeof p === 'object' && typeof (p as MarketplaceServerPlatform).package === 'string') out[key] = p as MarketplaceServerPlatform;
    }
    return out;
}

/** This platform's versions: the plugin's flat list (each with its `platform`), else the platform's own `versions`. */
function platformVersions(item: MarketplaceServerItem, p: MarketplaceServerPlatform): MarketplaceServerVersion[] | undefined {
    if (Array.isArray(item.versions)) return item.versions.filter((v) => v && (v.platform ?? SERVER_PLUGIN_PLATFORM) === SERVER_PLUGIN_PLATFORM);
    return Array.isArray(p.versions) ? p.versions : undefined;
}

/** The listed versions of this platform, newest first (its `latest` alone when no versions are given: a list item). */
function listedVersions(item: MarketplaceServerItem, p: MarketplaceServerPlatform): MarketplaceServerVersion[] {
    const versions = platformVersions(item, p) ?? (p.latest ? [{ version: p.latest, status: 'listed', serverRange: p.serverRange }] : []);
    return versions.filter((v) => v && isVersion(v.version) && (v.status ?? 'listed') === 'listed').sort((a, b) => compareDashboardPluginVersions(b.version, a.version));
}

/**
 * A list item without the marketplace's view of the platform it was asked for (another one's, or none): its `latest`,
 * `version`, `compatible`, `reason` and runtime flags, so this server's annotation comes from its own package only.
 */
function withoutPlatformView(item: MarketplaceServerItem): MarketplaceServerItem {
    const { latest: _l, version: _v, compatible: _c, reason: _r, autoInstall: _a, autoInstallReason: _ar, autoInstallDerived: _ad, needsConfiguration: _n, ...rest } = item;
    return rest as MarketplaceServerItem;
}

/** Whether the plugin runs without the host's code: the version's, else the platform's, else the item's `autoInstall`. */
function autoInstallOf(item: MarketplaceServerItem, p: MarketplaceServerPlatform | undefined, v?: MarketplaceServerVersion): { autoInstall: boolean; reason?: string } {
    for (const source of [v, p, item]) {
        if (source && typeof source.autoInstall === 'boolean') {
            return source.autoInstall ? { autoInstall: true } : { autoInstall: false, ...(typeof source.autoInstallReason === 'string' ? { reason: source.autoInstallReason } : {}) };
        }
    }
    return { autoInstall: true };
}

/**
 * Server plugins from the marketplace (`kind=server`), the package of this server's platform only (`node`): browses
 * them, installs, updates and removes packages in `<dataDir>/server-plugins/node_modules` (the tarball downloaded and
 * checked against the npm record's sha512 and the marketplace's, its dependencies the marketplace's pins or what the host
 * trusts, each checked too, the server's own packages shared; unpacked by the server, no install scripts), records them
 * in `installed.json` and marks a restart as required: they are loaded at the next start.
 */
export class ServerPluginMarketplace {
    readonly url: string;
    readonly install: DashboardInstallPolicy;
    readonly npmRegistry: string;
    private readonly fetchFn: MarketplaceFetch;
    private readonly timeoutMs: number;
    readonly trustedDependencies: readonly string[];
    private readonly hostPackageVersion: (name: string) => string | undefined;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        options: ServerPluginMarketplaceOptions,
        private readonly deps: ServerPluginMarketplaceDeps,
    ) {
        const url = (options.url ?? DEFAULT_MARKETPLACE_URL).trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^/\s]+/i.test(url)) throw new Error(`invalid marketplace url: ${options.url}`);
        const install = options.install ?? 'verified';
        if (!['verified', 'listed', 'off'].includes(install)) throw new Error(`invalid marketplace install policy: ${install}`);
        const registry = (options.npmRegistry ?? DEFAULT_NPM_REGISTRY).trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^/\s]+/i.test(registry)) throw new Error(`invalid npm registry: ${options.npmRegistry}`);
        const fetchFn = options.fetch ?? (globalThis as { fetch?: MarketplaceFetch }).fetch;
        if (!fetchFn) throw new Error('no fetch available: pass marketplace.fetch');
        this.url = url;
        this.install = install;
        this.npmRegistry = registry;
        this.fetchFn = fetchFn;
        this.timeoutMs = options.timeoutMs ?? 15_000;
        this.trustedDependencies = (options.trustedDependencies ?? []).filter((t) => typeof t === 'string' && t.trim());
        this.hostPackageVersion = options.hostPackageVersion ?? defaultHostPackageVersion;
    }

    /** The running server's version (`@qodalis/cli-server-node`). */
    get serverVersion(): string | null {
        return this.deps.installedPlugins().find((p) => p.id === SERVER_CORE_PACKAGE)?.version ?? null;
    }

    /** `GET /`: the marketplace, the policy, this platform and the server's version. */
    info(): { marketplaceUrl: string; install: DashboardInstallPolicy; platform: string; serverVersion: string | null; enabled: boolean } {
        return { marketplaceUrl: this.url, install: this.install, platform: SERVER_PLUGIN_PLATFORM, serverVersion: this.serverVersion, enabled: this.deps.plugins.enabled };
    }

    // ---------------------------------------------------------------- browsing

    /**
     * `GET /plugins`: the marketplace's server plugins, annotated for this server. `platform`: `this` (default) the ones
     * with a package for this server's platform, checked against this server's version; `all` every server plugin; or
     * `node`, `python`, `dotnet`, passed on to the marketplace. Plugins without a package for this platform are listed
     * but not installable (`not available for node`), also when the marketplace ignores the filter.
     */
    async search(params: { query?: string; page?: number; pageSize?: number; platform?: string } = {}): Promise<{ items: Array<MarketplaceServerItem & ServerPluginAnnotations>; total: number; page: number; pageSize: number }> {
        const filter = params.platform === undefined || params.platform === '' ? 'this' : params.platform;
        if (!SERVER_PLUGIN_PLATFORM_FILTERS.includes(filter)) throw new DashboardMarketplaceError(400, `invalid platform: ${filter} (${SERVER_PLUGIN_PLATFORM_FILTERS.join(', ')})`);
        const platform = filter === 'this' ? SERVER_PLUGIN_PLATFORM : filter === 'all' ? null : filter;
        // The marketplace's view of an item (latest, compatible, reason, autoInstall) is this server's only when it was asked for this platform
        const ownView = platform === SERVER_PLUGIN_PLATFORM;
        const qs = ownView ? this.platformQuery() : new URLSearchParams({ kind: 'server', ...(platform ? { platform } : {}) });
        if (params.query?.trim()) qs.set('query', params.query.trim().slice(0, 200));
        if (params.page !== undefined) qs.set('page', String(params.page));
        if (params.pageSize !== undefined) qs.set('pageSize', String(params.pageSize));
        const body = (await this.getJson(`${this.url}${MARKETPLACE_API_PATH}/plugins?${qs}`)) as { items?: unknown; total?: unknown; page?: unknown; pageSize?: unknown } | undefined;
        if (!body || !Array.isArray(body.items)) throw new DashboardMarketplaceError(502, 'marketplace unreachable');
        const all = body.items as MarketplaceServerItem[];
        const items = all.filter((i) => i && isValidServerPluginName(i.name) && i.kind === 'server');
        const filtered = items.length === all.length;
        return {
            items: items.map((item) => ({ ...item, ...this.annotate(ownView ? item : withoutPlatformView(item)) })),
            total: filtered && typeof body.total === 'number' ? body.total : items.length,
            page: typeof body.page === 'number' ? body.page : (params.page ?? 1),
            pageSize: typeof body.pageSize === 'number' ? body.pageSize : (params.pageSize ?? items.length),
        };
    }

    /** `kind=server&platform=node&serverVersion=<this server's>`. */
    private platformQuery(): URLSearchParams {
        const qs = new URLSearchParams({ kind: 'server', platform: SERVER_PLUGIN_PLATFORM });
        const server = this.serverVersion;
        if (server) qs.set('serverVersion', server);
        return qs;
    }

    /**
     * `GET /plugins/{name}`: one plugin with its platforms and versions (this platform's annotated with `allowed` and
     * `blockedReason`). Whether it installs without the host's code comes from its newest Node package's `qodalis`
     * block on the npm registry (the marketplace does not index `autoInstall`).
     */
    async details(name: string): Promise<MarketplaceServerItem & ServerPluginAnnotations> {
        let plugin = await this.fetchPlugin(name);
        const own = platformsOf(plugin)[SERVER_PLUGIN_PLATFORM];
        const newest = own ? listedVersions(plugin, own)[0] : undefined;
        if (own && newest && typeof plugin.autoInstall !== 'boolean') {
            const manifest = await this.npmManifest(own.package, newest.version).catch(() => undefined);
            const q = manifest?.qodalis as { autoInstall?: unknown; autoInstallReason?: unknown } | undefined;
            if (q?.autoInstall === false) {
                plugin = { ...plugin, autoInstall: false, ...(typeof q.autoInstallReason === 'string' ? { autoInstallReason: q.autoInstallReason } : {}) };
            }
        }
        const versions = Array.isArray(plugin.versions)
            ? plugin.versions.map((v) => {
                  if (!own || (v.platform ?? SERVER_PLUGIN_PLATFORM) !== SERVER_PLUGIN_PLATFORM) return v;
                  const reason = this.versionBlockedReason(plugin, own, v);
                  return { ...v, allowed: !reason, ...(reason ? { blockedReason: reason } : {}) };
              })
            : plugin.versions;
        return { ...plugin, ...(versions ? { versions } : {}), ...this.annotate(plugin) };
    }

    /** The npm registry's record of one version (its package.json with `dist`); undefined for a 404. */
    private async npmManifest(pkgName: string, version: string): Promise<(Record<string, unknown> & { dist?: { tarball?: unknown; integrity?: unknown } }) | undefined> {
        return (await this.getJson(`${this.npmRegistry}/${pkgName.replace('/', '%2f')}/${encodeURIComponent(version)}`)) as
            | (Record<string, unknown> & { dist?: { tarball?: unknown; integrity?: unknown } })
            | undefined;
    }

    /** The package as the host adds it in its code (listed among the installed plugins, not from the marketplace). */
    private addedInCode(pkg: string): CliInstalledPlugin | undefined {
        return this.deps.installedPlugins().find((p) => p.id === pkg && p.source !== 'marketplace');
    }

    private annotate(item: MarketplaceServerItem): ServerPluginAnnotations {
        const platforms = platformsOf(item);
        const own = platforms[SERVER_PLUGIN_PLATFORM];
        const record = this.recordOf(item.name);
        const otherPlatforms = Object.keys(platforms).filter((p) => p !== SERVER_PLUGIN_PLATFORM);
        const auto = autoInstallOf(item, own);
        let platform: ServerPluginAnnotations['platform'] = null;
        if (own && !platformVersions(item, own)) {
            // A list item: the marketplace says whether it runs here (it was given this server's version)
            const compatible = item.compatible !== false;
            const latest = typeof item.latest === 'string' ? item.latest : compatible && typeof own.latest === 'string' ? own.latest : null;
            platform = {
                package: own.package,
                latest,
                installed: record?.version ?? null,
                compatible,
                ...(compatible ? {} : { reason: typeof item.reason === 'string' ? item.reason : 'not compatible with this server' }),
            };
        } else if (own) {
            const listed = listedVersions(item, own);
            const server = this.serverVersion;
            const fitting = listed.find((v) => !server || satisfiesServerRange(server, v.serverRange ?? own.serverRange));
            const compatible = !!fitting;
            const range = listed[0]?.serverRange ?? own.serverRange;
            platform = {
                package: own.package,
                latest: fitting?.version ?? null,
                installed: record?.version ?? null,
                compatible,
                ...(compatible ? {} : { reason: listed.length ? `needs server ${range} (this server has ${server})` : `no listed version for ${SERVER_PLUGIN_PLATFORM}` }),
            };
        }
        const blockedReason = this.blockedReason(item, own, platform, auto);
        const code = !record && own ? this.addedInCode(own.package) : undefined;
        const installed: ServerPluginAnnotations['installed'] = record
            ? { version: record.version, source: 'marketplace' }
            : code
              ? { version: code.version && isVersion(code.version) ? code.version : null, source: 'code' }
              : null;
        return {
            platform,
            otherPlatforms,
            autoInstall: auto.autoInstall,
            ...(auto.reason ? { autoInstallReason: auto.reason } : {}),
            installed,
            updateAvailable: !!installed?.version && !!platform?.latest && isVersion(platform.latest) && compareDashboardPluginVersions(platform.latest, installed.version) > 0,
            allowed: !blockedReason,
            ...(blockedReason ? { blockedReason } : {}),
        };
    }

    /** `install disabled`, `unverified publisher`, `not available for node`, `needs setup in code`, `needs @qodalis/cli-server-node <range>`. */
    private blockedReason(
        item: MarketplaceServerItem,
        own: MarketplaceServerPlatform | undefined,
        platform: ServerPluginAnnotations['platform'],
        auto: { autoInstall: boolean; reason?: string },
    ): string | undefined {
        if (!this.deps.plugins.enabled) return 'server plugins disabled';
        if (this.install === 'off') return 'install disabled';
        if (this.install === 'verified' && item.publisher?.verified !== true) return 'unverified publisher';
        if (!own) return `not available for ${SERVER_PLUGIN_PLATFORM}`;
        if (!auto.autoInstall) return 'needs setup in code';
        if (platform && !platform.compatible) return platform.reason;
        return undefined;
    }

    private versionBlockedReason(plugin: MarketplaceServerItem, own: MarketplaceServerPlatform, v: MarketplaceServerVersion): string | undefined {
        const auto = autoInstallOf(plugin, own, v);
        const server = this.serverVersion;
        const compatible = !server || satisfiesServerRange(server, v.serverRange ?? own.serverRange);
        const reason = this.blockedReason(plugin, own, compatible ? null : { package: own.package, latest: null, installed: null, compatible, reason: `needs server ${v.serverRange ?? own.serverRange} (this server has ${server})` }, auto);
        if (reason) return reason;
        if ((v.status ?? 'listed') !== 'listed') return `version ${v.status}`;
        return undefined;
    }

    private async getJson(url: string): Promise<unknown> {
        let res: MarketplaceFetchResponse;
        try {
            res = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch {
            throw new DashboardMarketplaceError(502, url.startsWith(this.url) ? 'marketplace unreachable' : 'npm registry unreachable');
        }
        if (res.status === 404) return undefined;
        if (!res.ok) throw new DashboardMarketplaceError(502, url.startsWith(this.url) ? 'marketplace unreachable' : 'npm registry unreachable');
        try {
            return await res.json();
        } catch {
            throw new DashboardMarketplaceError(502, url.startsWith(this.url) ? 'marketplace unreachable' : 'npm registry unreachable');
        }
    }

    private async fetchPlugin(name: string): Promise<MarketplaceServerItem> {
        if (!isValidServerPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid plugin name');
        const plugin = (await this.getJson(`${this.url}${MARKETPLACE_API_PATH}/plugins/${encodeURIComponent(name)}?${this.platformQuery()}`)) as MarketplaceServerItem | undefined;
        if (!plugin || typeof plugin !== 'object') throw new DashboardMarketplaceError(404, `plugin not found: ${name}`);
        if (plugin.name !== name) throw new DashboardMarketplaceError(502, 'marketplace unreachable');
        return plugin;
    }

    // ---------------------------------------------------------------- installed

    /** The installed list (`installed.json`): the update checker compares its versions after a change. */
    installedRecords(): CliServerPluginRecord[] {
        return this.deps.plugins.records();
    }

    private recordOf(name: string): CliServerPluginRecord | undefined {
        return this.deps.plugins.records().find((r) => r.name === name);
    }

    private loadedOf(name: string): CliServerPluginState | undefined {
        return this.deps.plugins.states().find((s) => s.source !== 'code' && s.name === name && (s.status === 'loaded' || s.status === 'needs-configuration'));
    }

    /** One installed plugin with how it runs in this process. */
    view(record: CliServerPluginRecord): InstalledServerPlugin {
        const state = this.deps.plugins.states().find((s) => s.source !== 'code' && s.name === record.name);
        const running = state?.status === 'loaded' || state?.status === 'needs-configuration';
        const loaded = running ? state!.version : null;
        let status: InstalledServerPlugin['status'];
        let error = record.error;
        let missing: string[] | undefined;
        if (loaded === record.version) {
            status = state!.status as 'loaded' | 'needs-configuration';
            if (status === 'needs-configuration') missing = state!.missing ?? record.missing ?? [];
        } else if (state && state.version === record.version) {
            status = state.status as InstalledServerPlugin['status'];
            error = state.error ?? error;
        } else status = 'pending';
        const settings = (state?.version === record.version ? state.settings : undefined) ?? record.settings;
        return {
            name: record.name,
            package: record.package,
            version: record.version,
            title: record.title ?? record.name,
            icon: record.icon ?? null,
            description: record.description ?? null,
            installedAt: record.installedAt,
            installedBy: record.installedBy,
            status,
            loadedVersion: loaded,
            ...(error && status !== 'loaded' && status !== 'pending' && status !== 'needs-configuration' ? { error } : {}),
            ...(missing ? { missing: [...missing] } : {}),
            ...(settings ? { settings } : {}),
        };
    }

    /** `GET /installed`: the installed plugins, then the removed ones still running; `updateAvailable` when the marketplace answers. */
    async installed(options: { checkUpdates?: boolean } = {}): Promise<InstalledServerPlugin[]> {
        const records = this.deps.plugins.records();
        const views = records.map((r) => this.view(r));
        for (const s of this.deps.plugins.states()) {
            if (s.source === 'code' || (s.status !== 'loaded' && s.status !== 'needs-configuration') || records.some((r) => r.name === s.name)) continue;
            views.push({ name: s.name, package: s.package, version: s.version, title: s.name, icon: null, description: null, installedAt: '', installedBy: '', status: 'removed', loadedVersion: s.version });
        }
        if (!options.checkUpdates) return views;
        return Promise.all(
            views.map(async (v) => {
                if (v.status === 'removed') return v;
                try {
                    const latest = this.annotate(await this.fetchPlugin(v.name)).platform?.latest;
                    return { ...v, updateAvailable: !!latest && isVersion(latest) && compareDashboardPluginVersions(latest, v.version) > 0 };
                } catch {
                    return v;
                }
            }),
        );
    }

    // ---------------------------------------------------------------- changes

    /** `POST /installed`: installs this platform's package of `name` (the newest compatible version, or `version`). */
    installPlugin(name: unknown, version: unknown, actor: DashboardMarketplaceActor): Promise<ServerPluginChangeResult> {
        return this.exclusive(async () => {
            const { plugin, own, target } = await this.prepare(name, version);
            const existing = this.recordOf(plugin.name);
            if (existing) throw new DashboardMarketplaceError(409, `already installed: ${plugin.name}@${existing.version}`);
            const record = await this.installPackage(plugin, own, target, actor);
            const records = this.deps.plugins.records().filter((r) => r.name !== record.name);
            await this.deps.plugins.save([...records, record]);
            const restartRequired = this.syncRestart(record.name, `Install ${record.name} ${record.version}`);
            await this.changed('install', record, actor);
            return { ...this.view(record), restartRequired };
        });
    }

    /** `PUT /installed/{name}`: updates to `version` (default: the newest compatible one); `changed: false` when it already is. */
    updatePlugin(name: unknown, version: unknown, actor: DashboardMarketplaceActor): Promise<ServerPluginChangeResult> {
        return this.exclusive(async () => {
            if (!isValidServerPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid plugin name');
            const current = this.recordOf(name);
            if (!current) throw new DashboardMarketplaceError(404, `not installed: ${name}`);
            const { plugin, own, target } = await this.prepare(name, version);
            if (own.package !== current.package) throw new DashboardMarketplaceError(409, `the marketplace's package is ${own.package}, ${current.package} is installed: remove it first`);
            if (target.version === current.version) {
                return { ...this.view(current), restartRequired: this.restartPending(current.name), changed: false, previousVersion: current.version };
            }
            const record = await this.installPackage(plugin, own, target, actor);
            await rm(this.tarballPath(current.package, current.version), { force: true });
            await this.deps.plugins.save(this.deps.plugins.records().map((r) => (r.name === record.name ? record : r)));
            const restartRequired = this.syncRestart(record.name, `Update ${record.name} ${current.version} -> ${record.version}`);
            await this.changed('update', record, actor, current.version);
            return { ...this.view(record), restartRequired, changed: true, previousVersion: current.version };
        });
    }

    /** `DELETE /installed/{name}`: uninstalls the package; it keeps running until a restart. */
    removePlugin(name: unknown, actor: DashboardMarketplaceActor): Promise<ServerPluginChangeResult> {
        return this.exclusive(async () => {
            if (!isValidServerPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid plugin name');
            if (!this.deps.plugins.enabled) throw new DashboardMarketplaceError(403, 'server plugins disabled');
            const current = this.recordOf(name);
            if (!current) throw new DashboardMarketplaceError(404, `not installed: ${name}`);
            await rm(this.packageDir(current.package), { recursive: true, force: true });
            await rm(this.tarballPath(current.package, current.version), { force: true });
            await this.deps.plugins.save(this.deps.plugins.records().filter((r) => r.name !== current.name));
            const restartRequired = this.syncRestart(current.name, `Remove ${current.name} ${current.version}`);
            await this.changed('remove', current, actor);
            const view = this.view(current);
            const loaded = this.loadedOf(current.name);
            return { ...view, status: loaded ? 'removed' : view.status, restartRequired };
        });
    }

    /** Runs changes one at a time; a file system error on the plugins folder becomes a 500 naming the folder. */
    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const guarded = () =>
            fn().catch((err: unknown) => {
                const message = pluginsFolderError(err, this.deps.plugins.dir, this.deps.folderHint ?? DATA_DIR_HINT);
                if (message) throw new DashboardMarketplaceError(500, message);
                throw err;
            });
        const run = this.queue.then(guarded, guarded);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** The plugin, this platform's package and the version to install, after the policy, platform, setup and range checks. */
    private async prepare(name: unknown, version: unknown): Promise<{ plugin: MarketplaceServerItem; own: MarketplaceServerPlatform; target: MarketplaceServerVersion }> {
        if (!isValidServerPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid plugin name');
        if (version !== undefined && version !== null && !isVersion(version)) throw new DashboardMarketplaceError(400, 'invalid version');
        if (!this.deps.plugins.enabled) throw new DashboardMarketplaceError(403, 'server plugins disabled');
        const plugin = await this.fetchPlugin(name);
        if (plugin.kind !== 'server') throw new DashboardMarketplaceError(400, `not a server plugin: ${name}`);
        if (this.install === 'off') throw new DashboardMarketplaceError(403, 'install disabled');
        if (this.install === 'verified' && plugin.publisher?.verified !== true) throw new DashboardMarketplaceError(403, 'publisher not verified');
        const own = platformsOf(plugin)[SERVER_PLUGIN_PLATFORM];
        if (!own) throw new DashboardMarketplaceError(400, `not available for ${SERVER_PLUGIN_PLATFORM}: ${name}`);
        if (!isPackage(own.package)) throw new DashboardMarketplaceError(502, 'invalid marketplace record: package');
        const listed = listedVersions(plugin, own);
        const server = this.serverVersion;
        let target: MarketplaceServerVersion | undefined;
        if (version) {
            target = listed.find((v) => v.version === version);
            if (!target) throw new DashboardMarketplaceError(404, `version not found: ${name}@${version}`);
        } else {
            target = listed.find((v) => !server || satisfiesServerRange(server, v.serverRange ?? own.serverRange)) ?? listed[0];
            if (!target) throw new DashboardMarketplaceError(404, `no installable version: ${name}`);
        }
        const auto = autoInstallOf(plugin, own, target);
        if (!auto.autoInstall) throw new DashboardMarketplaceError(400, `needs setup in code${auto.reason ? `: ${auto.reason}` : ''}`);
        const range = target.serverRange ?? own.serverRange;
        if (server && !satisfiesServerRange(server, range)) {
            throw new DashboardMarketplaceError(400, `incompatible: ${own.package}@${target.version} needs server ${range} (this server has ${server})`);
        }
        const host = this.addedInCode(own.package);
        if (host) throw new DashboardMarketplaceError(409, `already added in code: ${own.package}${host.version ? `@${host.version}` : ''}`);
        return { plugin, own, target };
    }

    /** Downloads the tarball, checks it, and installs it with npm. Throws without changing anything when a check fails. */
    private async installPackage(
        plugin: MarketplaceServerItem,
        own: MarketplaceServerPlatform,
        target: MarketplaceServerVersion,
        actor: DashboardMarketplaceActor,
    ): Promise<CliServerPluginRecord> {
        const pkgName = own.package;
        const npmRecord = await this.npmManifest(pkgName, target.version);
        if (!npmRecord) throw new DashboardMarketplaceError(404, `not on the npm registry: ${pkgName}@${target.version}`);
        // The package's own word on runtime install, before anything is downloaded (the tarball's is checked again)
        const declared = npmRecord.qodalis as { autoInstall?: unknown; autoInstallReason?: unknown } | undefined;
        if (declared?.autoInstall === false) {
            throw new DashboardMarketplaceError(400, `needs setup in code${typeof declared.autoInstallReason === 'string' ? `: ${declared.autoInstallReason}` : ''}`);
        }
        const integrity = npmRecord.dist?.integrity;
        const tarballUrl = npmRecord.dist?.tarball;
        if (typeof integrity !== 'string' || !SHA512.test(integrity)) throw new DashboardMarketplaceError(502, 'the npm record has no sha512 integrity');
        if (typeof tarballUrl !== 'string' || !/^https?:\/\//i.test(tarballUrl)) throw new DashboardMarketplaceError(502, 'the npm record has no tarball');
        if (typeof target.integrity === 'string' && target.integrity && target.integrity !== integrity) {
            throw new DashboardMarketplaceError(502, 'integrity mismatch: the marketplace and the npm registry disagree');
        }
        const bytes = await this.download(tarballUrl);
        if (sha512Integrity(bytes) !== integrity) throw new DashboardMarketplaceError(502, `integrity mismatch: ${pkgName}@${target.version}`);

        // The package itself must say it is a server plugin for this server
        const pkg = tarballPackageJson(bytes);
        if (pkg.name !== pkgName || pkg.version !== target.version) throw new DashboardMarketplaceError(502, `the tarball is ${String(pkg.name)}@${String(pkg.version)}, not ${pkgName}@${target.version}`);
        const q = pkg.qodalis as { kind?: unknown; entry?: unknown; autoInstall?: unknown; autoInstallReason?: unknown } | undefined;
        if (!q || q.kind !== 'server') throw new DashboardMarketplaceError(400, `not a server plugin package: ${pkgName} (no qodalis.kind "server")`);
        if (q.autoInstall === false) throw new DashboardMarketplaceError(400, `needs setup in code${typeof q.autoInstallReason === 'string' ? `: ${q.autoInstallReason}` : ''}`);
        if (typeof q.entry !== 'string' || !q.entry.trim()) throw new DashboardMarketplaceError(400, `${pkgName} declares no qodalis.entry`);
        const server = this.serverVersion;
        for (const field of ['peerDependencies', 'dependencies'] as const) {
            for (const core of SERVER_CORE_PACKAGES) {
                const range = (pkg[field] as Record<string, unknown> | undefined)?.[core];
                if (server && typeof range === 'string' && !satisfiesServerRange(server, range)) {
                    throw new DashboardMarketplaceError(400, `incompatible: ${pkgName}@${target.version} needs server ${range} (this server has ${server})`);
                }
            }
        }

        // Its dependencies: the server's own copies, the marketplace's pins or what the host trusts, each checked
        const dependencies = await this.resolveDependencies(pkg, target);

        // Verified: unpacked into <dir>/node_modules/<package>, its dependencies in its own node_modules (no install
        // scripts ever run, nothing else is fetched); the tarball is kept
        const dir = this.deps.plugins.dir;
        await mkdir(join(dir, 'tarballs'), { recursive: true });
        const tarball = this.tarballPath(pkgName, target.version);
        await writeFile(tarball, bytes);
        try {
            await this.unpackAll(pkgName, bytes, dependencies);
        } catch (err) {
            await rm(tarball, { force: true });
            throw err instanceof DashboardMarketplaceError ? err : new DashboardMarketplaceError(502, `install failed: ${(err as Error).message}`);
        }
        const title = [plugin.title, plugin.name].find((t) => typeof t === 'string' && t.trim()) as string;
        return {
            name: plugin.name,
            package: pkgName,
            version: target.version,
            integrity,
            title: title.trim().slice(0, 60),
            ...(typeof plugin.icon === 'string' ? { icon: plugin.icon } : {}),
            ...(typeof plugin.description === 'string' ? { description: plugin.description.slice(0, 500) } : {}),
            installedAt: new Date().toISOString(),
            installedBy: actor.userName,
            ...(dependencies.length ? { dependencies: dependencies.map(({ id, version, integrity, source }) => ({ id, version, integrity, source })) } : {}),
        };
    }

    /**
     * The dependencies to install with a package, in the order found: for each runtime dependency (`dependencies`,
     * `optionalDependencies`; peers are the host's) of the package and of every dependency installed: a `@qodalis/*`
     * package or one the server resolves at a compatible version is shared (never installed); at an incompatible
     * version it is refused (`incompatible dependency`). Otherwise, with the marketplace's pins for this version, exactly
     * the pinned version (in the range, its tarball matching the pin's sha512); a dependency without a pin is refused.
     * Without pins, only a dependency the host trusts (`trustedDependencies`): the newest version in the range from the
     * npm registry, its tarball matching the registry's sha512. An optional dependency that cannot be installed is left out.
     */
    private async resolveDependencies(root: Record<string, unknown>, target: MarketplaceServerVersion): Promise<ResolvedDependency[]> {
        const rawPins = target.dependencies;
        const pinned = Array.isArray(rawPins);
        const pins = new Map<string, MarketplaceDependencyPin>();
        for (const pin of pinned ? rawPins : []) {
            if (!pin || !isPackage(pin.id) || !isVersion(pin.version) || typeof pin.integrity !== 'string' || !SHA512.test(pin.integrity)) {
                throw new DashboardMarketplaceError(502, `invalid marketplace record: dependency ${String((pin as { id?: unknown })?.id)}`);
            }
            pins.set(pin.id, pin);
        }
        const resolved = new Map<string, ResolvedDependency>();
        const queue: Array<{ id: string; range: string; optional: boolean }> = [];
        const enqueue = (pkg: Record<string, unknown>) => {
            for (const [field, optional] of [['dependencies', false], ['optionalDependencies', true]] as const) {
                const deps = pkg[field];
                if (!deps || typeof deps !== 'object') continue;
                for (const [id, range] of Object.entries(deps as Record<string, unknown>)) {
                    if (typeof range === 'string') queue.push({ id, range, optional });
                }
            }
        };
        enqueue(root);
        while (queue.length) {
            const { id, range, optional } = queue.shift()!;
            try {
                if (!isPackage(id)) throw new DashboardMarketplaceError(400, `invalid dependency: ${id}`);
                if (/^(?:file|link|git|git\+\w+|https?|github):/.test(range) || range.includes('/')) {
                    throw new DashboardMarketplaceError(400, `untrusted dependency: ${id} (${range} is not a registry version)`);
                }
                // The server's own copy is shared: never installed, never shadowed
                const host = this.hostPackageVersion(id);
                if (host !== undefined || id.startsWith('@qodalis/')) {
                    if (host === undefined) throw new DashboardMarketplaceError(400, `incompatible dependency: ${id}@${range} (a server package the host does not have)`);
                    if (!satisfiesServerRange(host, range)) throw new DashboardMarketplaceError(400, `incompatible dependency: ${id}@${range} (the server has ${host})`);
                    continue;
                }
                const already = resolved.get(id);
                if (already) {
                    if (!satisfiesServerRange(already.version, range)) throw new DashboardMarketplaceError(400, `incompatible dependency: ${id}@${range} (${already.version} is installed for another dependency)`);
                    continue;
                }
                const dep = pinned ? await this.pinnedDependency(id, range, pins.get(id)) : await this.trustedDependency(id, range);
                resolved.set(id, dep);
                const manifest = tarballPackageJson(dep.bytes);
                if (manifest.name !== id || manifest.version !== dep.version) {
                    throw new DashboardMarketplaceError(502, `the tarball is ${String(manifest.name)}@${String(manifest.version)}, not ${id}@${dep.version}`);
                }
                enqueue(manifest);
            } catch (err) {
                if (optional && err instanceof DashboardMarketplaceError && err.status === 400) continue;
                throw err;
            }
        }
        return [...resolved.values()];
    }

    /** A pinned dependency: the pin's version in the range, its npm tarball matching the pin's sha512. */
    private async pinnedDependency(id: string, range: string, pin: MarketplaceDependencyPin | undefined): Promise<ResolvedDependency> {
        if (!pin) throw new DashboardMarketplaceError(400, `untrusted dependency: ${id} (not pinned by the marketplace)`);
        if (!satisfiesServerRange(pin.version, range)) throw new DashboardMarketplaceError(400, `incompatible dependency: ${id}@${range} (the marketplace pins ${pin.version})`);
        const record = await this.npmManifest(id, pin.version);
        const tarballUrl = record?.dist?.tarball;
        if (typeof tarballUrl !== 'string' || !/^https?:\/\//i.test(tarballUrl)) throw new DashboardMarketplaceError(502, `not on the npm registry: ${id}@${pin.version}`);
        if (record?.dist?.integrity !== undefined && record.dist.integrity !== pin.integrity) {
            throw new DashboardMarketplaceError(502, `integrity mismatch: the marketplace and the npm registry disagree on ${id}@${pin.version}`);
        }
        const bytes = await this.download(tarballUrl);
        if (sha512Integrity(bytes) !== pin.integrity) throw new DashboardMarketplaceError(502, `integrity mismatch: ${id}@${pin.version}`);
        return { id, version: pin.version, integrity: pin.integrity, source: 'pinned', bytes };
    }

    /** A dependency the host trusts: the newest registry version in the range, its tarball matching the registry's sha512. */
    private async trustedDependency(id: string, range: string): Promise<ResolvedDependency> {
        if (!isTrustedDependency(id, this.trustedDependencies)) {
            throw new DashboardMarketplaceError(400, `untrusted dependency: ${id} (the marketplace pins none and the server does not trust it)`);
        }
        const doc = (await this.getJson(`${this.npmRegistry}/${id.replace('/', '%2f')}`)) as
            | { versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown }; deprecated?: unknown }>; 'dist-tags'?: Record<string, string> }
            | undefined;
        const versions = doc?.versions ?? {};
        const latest = doc?.['dist-tags']?.latest;
        const candidates = Object.keys(versions).filter((v) => isVersion(v) && satisfiesServerRange(v, range));
        const version =
            latest && candidates.includes(latest)
                ? latest
                : candidates.filter((v) => !/-/.test(v) || /-/.test(range)).sort(compareDashboardPluginVersions).pop() ?? candidates.sort(compareDashboardPluginVersions).pop();
        if (!version) throw new DashboardMarketplaceError(400, `incompatible dependency: ${id}@${range} (no version on the npm registry)`);
        const dist = versions[version].dist;
        if (typeof dist?.integrity !== 'string' || !SHA512.test(dist.integrity)) throw new DashboardMarketplaceError(502, `the npm record of ${id}@${version} has no sha512 integrity`);
        if (typeof dist.tarball !== 'string' || !/^https?:\/\//i.test(dist.tarball)) throw new DashboardMarketplaceError(502, `the npm record of ${id}@${version} has no tarball`);
        const bytes = await this.download(dist.tarball);
        if (sha512Integrity(bytes) !== dist.integrity) throw new DashboardMarketplaceError(502, `integrity mismatch: ${id}@${version}`);
        return { id, version, integrity: dist.integrity, source: 'trusted', bytes };
    }

    /** `<dir>/node_modules/<package>`, inside the directory. */
    private packageDir(pkgName: string): string {
        if (!isPackage(pkgName)) throw new DashboardMarketplaceError(400, 'invalid package');
        const base = resolve(this.deps.plugins.dir, 'node_modules');
        const path = resolve(base, pkgName);
        if (!path.startsWith(base + sep)) throw new DashboardMarketplaceError(400, 'invalid package');
        return path;
    }

    /** Unpacks the package and its dependencies (in its own node_modules) into a staging folder, then swaps it in. */
    private async unpackAll(pkgName: string, bytes: Uint8Array, dependencies: ResolvedDependency[]): Promise<void> {
        const target = this.packageDir(pkgName);
        const staging = `${target}.staging-${process.pid}-${Date.now()}`;
        await rm(staging, { recursive: true, force: true });
        try {
            await unpackTarball(bytes, staging);
            for (const dep of dependencies) {
                const depDir = resolve(staging, 'node_modules', dep.id);
                if (!depDir.startsWith(resolve(staging, 'node_modules') + sep)) throw new DashboardMarketplaceError(400, `invalid dependency: ${dep.id}`);
                await unpackTarball(dep.bytes, depDir);
            }
            await rm(target, { recursive: true, force: true });
            await mkdir(dirname(target), { recursive: true });
            await rename(staging, target);
        } catch (err) {
            await rm(staging, { recursive: true, force: true });
            throw err;
        }
    }

    /** `<dir>/tarballs/<name, scope's / as +>-<version>.tgz`, inside the directory. */
    private tarballPath(pkgName: string, version: string): string {
        if (!isPackage(pkgName) || !isVersion(version)) throw new DashboardMarketplaceError(400, 'invalid package');
        const base = resolve(this.deps.plugins.dir, 'tarballs');
        const path = resolve(base, `${pkgName.replace('/', '+')}-${version}.tgz`);
        if (!path.startsWith(base + sep)) throw new DashboardMarketplaceError(400, 'invalid package');
        return path;
    }

    private async download(url: string): Promise<Uint8Array> {
        let res: MarketplaceFetchResponse;
        try {
            res = await this.fetchFn(url, { signal: AbortSignal.timeout(Math.max(this.timeoutMs, 60_000)) });
        } catch {
            throw new DashboardMarketplaceError(502, 'download failed: tarball');
        }
        if (!res.ok) throw new DashboardMarketplaceError(502, `download failed: tarball (${res.status})`);
        const length = Number(res.headers.get('content-length'));
        if (Number.isFinite(length) && length > SERVER_PLUGIN_MAX_TARBALL_BYTES) throw new DashboardMarketplaceError(502, 'tarball too large');
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > SERVER_PLUGIN_MAX_TARBALL_BYTES) throw new DashboardMarketplaceError(502, 'tarball too large');
        return bytes;
    }

    /** True when the installed list differs from what this process runs for `name`. */
    private restartPending(name: string): boolean {
        const record = this.recordOf(name);
        const loaded = this.loadedOf(name);
        return record ? loaded?.version !== record.version : !!loaded;
    }

    /** Marks (or clears, when the installed list is back to what runs) the restart for a plugin; true when one is needed. */
    private syncRestart(name: string, description: string): boolean {
        const pending = this.restartPending(name);
        const restart = this.deps.restart;
        if (restart) {
            const id = `plugin:${name}`;
            restart.clearRequired(id);
            if (pending) restart.markRequired({ id, source: 'plugins', description });
        }
        return pending;
    }

    private async changed(action: 'install' | 'update' | 'remove', record: CliServerPluginRecord, actor: DashboardMarketplaceActor, previousVersion?: string): Promise<void> {
        const sink = this.deps.audit?.();
        if (sink) {
            try {
                await sink({
                    timestamp: Date.now(),
                    event: `server.plugin.${action}`,
                    username: actor.userName,
                    ...(actor.userId ? { userId: actor.userId, actorId: actor.userId } : {}),
                    actor: actor.userName,
                    target: record.name,
                    details: previousVersion ? `${record.package} ${previousVersion} -> ${record.version}` : `${record.package}@${record.version}`,
                    properties: { name: record.name, package: record.package, version: record.version, ...(previousVersion ? { previousVersion } : {}) },
                });
            } catch (err) {
                console.error('[qcli-admin] audit of a server plugin change failed:', (err as Error)?.message ?? err);
            }
        }
        this.deps.publish?.(SERVER_PLUGINS_CHANGED_EVENT, {
            action,
            name: record.name,
            package: record.package,
            version: record.version,
            ...(previousVersion ? { previousVersion } : {}),
        });
    }
}
