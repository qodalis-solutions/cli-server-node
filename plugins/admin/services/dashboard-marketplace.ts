import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { mkdir, rename, rm, writeFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { join, resolve, sep } from 'path';
import { dashboardModulePage, validateDashboardExtension, type CliDashboardExtension } from '@qodalis/cli-server-abstractions';

/** Who may install dashboard plugins: listed versions of verified publishers, any listed version, or nobody (browse only). */
export type DashboardInstallPolicy = 'verified' | 'listed' | 'off';

/** The dashboard extension API this server's dashboard implements; versions needing a newer one are refused. */
export const DASHBOARD_API_VERSION = 1;
export const DEFAULT_MARKETPLACE_URL = 'https://plugins.qodalis.com';
/** Where installed dashboard plugins are kept, relative to the working directory. */
export const DEFAULT_DASHBOARD_PLUGINS_DIR = join('qcli-data', 'dashboard-plugins');
/** CDNs the bundles are downloaded from, in order (jsDelivr, then unpkg). */
export const DEFAULT_DASHBOARD_PLUGIN_CDNS: readonly string[] = ['https://cdn.jsdelivr.net/npm', 'https://unpkg.com'];
/** The most bytes one file of a dashboard plugin may have. */
export const DASHBOARD_PLUGIN_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** The public API of the marketplace, below its URL. */
export const MARKETPLACE_API_PATH = '/api/v1/qcli/marketplace';
/** The event published when a marketplace plugin is installed, updated or removed (audience `admin:access`). */
export const DASHBOARD_EXTENSIONS_CHANGED_EVENT = 'dashboard:extensions-changed';
export const DASHBOARD_INSTALL_PERMISSION = 'dashboard:install';

/** The part of `fetch`'s response the marketplace client reads. */
export interface MarketplaceFetchResponse {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}

/** `fetch` as the marketplace client calls it (the global one by default; tests pass a fake). */
export type MarketplaceFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<MarketplaceFetchResponse>;

/** The admin plugin's marketplace options (`CliAdminBuilder.setMarketplace`). */
export interface DashboardMarketplaceOptions {
    /** The marketplace (default `https://plugins.qodalis.com`). */
    url?: string;
    /** `verified` (default): listed versions of verified publishers only; `listed`: any listed version; `off`: browse only. */
    install?: DashboardInstallPolicy;
    /** Where installed plugins are kept (default `./qcli-data/dashboard-plugins`, from the working directory). */
    dir?: string;
    /** The HTTP client for the marketplace and the CDNs (default: the global `fetch`). */
    fetch?: MarketplaceFetch;
    /** The CDNs bundles are downloaded from, in order (default jsDelivr, then unpkg). */
    cdns?: string[];
    /** Timeout of each request in milliseconds (default 15000). */
    timeoutMs?: number;
}

/** A refused or failed marketplace operation: the HTTP status and the `{ error }` text. */
export class DashboardMarketplaceError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'DashboardMarketplaceError';
    }
}

/** Who installs or removes a plugin (recorded as `installedBy` and in the audit log). */
export interface DashboardMarketplaceActor {
    userId?: string;
    userName: string;
}

/** One file of an installed plugin as `installed.json` keeps it. */
export interface InstalledDashboardPluginFile {
    /** The stored file: `extension.js` or `extension.css`. */
    file: 'extension.js' | 'extension.css';
    /** The file in the npm package (`dist/extension.js`). */
    path: string;
    /** `sha384-…`, as the marketplace published it and the stored bytes match. */
    integrity: string;
    size: number;
}

/** An installed plugin as `installed.json` keeps it. */
export interface InstalledDashboardPluginRecord {
    name: string;
    version: string;
    /** The dashboard extension's id (its page: `/x/<id>`, its files: `/qcli/modules/<id>/`). */
    id: string;
    title: string;
    icon?: string;
    files: InstalledDashboardPluginFile[];
    /** ISO 8601 UTC. */
    installedAt: string;
    installedBy: string;
}

/** An installed plugin as `GET /installed` lists it. */
export interface InstalledDashboardPlugin {
    name: string;
    version: string;
    title: string;
    icon: string | null;
    id: string;
    installedAt: string;
    installedBy: string;
    /** Whether the marketplace has a newer installable version; absent when the marketplace was not asked or unreachable. */
    updateAvailable?: boolean;
}

/** Where the plugins' pages are registered (the server's builder). */
export interface DashboardExtensionHost {
    list(): ReadonlyArray<{ id: string }>;
    add(extension: CliDashboardExtension): void;
    remove(id: string): boolean;
}

/** An audit entry (the shape of `AuditEntry` of `@qodalis/cli-server-abstractions`). */
export interface DashboardMarketplaceAuditEntry {
    timestamp: number;
    event: string;
    username: string;
    userId?: string;
    actor?: string;
    actorId?: string;
    target?: string;
    details?: string;
    properties?: Record<string, unknown>;
}

export interface DashboardMarketplaceDeps {
    extensions: DashboardExtensionHost;
    /** The server plugin packages installed (`GET /plugins/installed`), for `requires.installed`. */
    serverPlugins: () => ReadonlyArray<{ id: string }>;
    /** The audit sink, read on every change. */
    audit?: () => ((entry: DashboardMarketplaceAuditEntry) => Promise<void>) | undefined;
    /** Publishes an event to holders of `admin:access`. */
    publish?: (type: string, data: Record<string, unknown>) => void;
}

/** What the marketplace lists (its fields are passed through, the annotations added). */
export interface MarketplaceDashboardItem {
    name: string;
    shortName?: string;
    title?: string;
    icon?: string;
    kind?: string;
    publisher?: { name?: string; verified?: boolean };
    latest?: string | null;
    version?: string | null;
    dashboardApi?: number;
    serverPackages?: unknown;
    versions?: MarketplaceDashboardVersion[];
    extension?: { id?: unknown };
    [key: string]: unknown;
}

export interface MarketplaceDashboardFile {
    path: string;
    integrity: string;
    size?: number;
}

export interface MarketplaceDashboardVersion {
    version: string;
    status?: string;
    kind?: string;
    files?: MarketplaceDashboardFile[];
    dashboardApi?: number;
    serverPackages?: unknown;
    extension?: { id?: unknown };
    [key: string]: unknown;
}

/** The annotations the server adds to a marketplace item. */
export interface DashboardPluginAnnotations {
    installed: { version: string } | null;
    updateAvailable: boolean;
    allowed: boolean;
    blockedReason?: string;
    requires: { serverPackage: string; installed: boolean } | null;
}

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const OFFICIAL_MODULE = /^@qodalis\/cli-dashboard-module-([a-z0-9][a-z0-9-]{0,39})$/;
const FILE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const INTEGRITY = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const INSTALLED_FILE = 'installed.json';

/** True for a valid npm package name (lower case, optionally scoped, at most 214 characters). */
export function isValidDashboardPluginName(name: unknown): name is string {
    return typeof name === 'string' && name.length <= 214 && NPM_NAME.test(name);
}

/** True for a semver version (`1.2.3`, `1.2.3-beta.1`). */
export function isValidDashboardPluginVersion(version: unknown): version is string {
    return typeof version === 'string' && version.length <= 64 && SEMVER.test(version);
}

/**
 * The directory a package is kept in: the name with the scope's `/` as `+` (`@acme/tickets` -> `@acme+tickets`),
 * which no npm name contains, so names never clash or leave the storage directory. Throws for an invalid name.
 */
export function dashboardPluginDirName(name: string): string {
    if (!isValidDashboardPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid package name');
    return name.replace('/', '+');
}

/**
 * The dashboard extension id of a package: `@qodalis/cli-dashboard-module-<id>` -> `<id>`, else the extension's own id
 * (the marketplace record's `extension.id`), else the package's own name (scope dropped, `cli-dashboard-` and
 * `module-`/`plugin-` prefixes dropped, other characters as `-`, at most 40). Undefined when nothing fits.
 */
export function dashboardPluginId(name: string, extensionId?: unknown): string | undefined {
    const official = OFFICIAL_MODULE.exec(name);
    if (official) return official[1];
    if (typeof extensionId === 'string' && EXTENSION_ID.test(extensionId)) return extensionId;
    const base = (name.split('/').pop() ?? '')
        .replace(/^cli-dashboard-(?:module-|plugin-)?/, '')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, 40)
        .replace(/-+$/, '');
    return EXTENSION_ID.test(base) ? base : undefined;
}

/** Compares two semver versions (prereleases before their release); a non-semver text compares as text. */
export function compareDashboardPluginVersions(a: string, b: string): number {
    const pa = SEMVER.exec(a);
    const pb = SEMVER.exec(b);
    if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 1; i <= 3; i++) {
        const d = Number(pa[i]) - Number(pb[i]);
        if (d !== 0) return Math.sign(d);
    }
    if (!pa[4] && !pb[4]) return 0;
    if (!pa[4]) return 1;
    if (!pb[4]) return -1;
    const xa = pa[4].split('.');
    const xb = pb[4].split('.');
    for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
        if (xa[i] === undefined) return -1;
        if (xb[i] === undefined) return 1;
        const na = /^\d+$/.test(xa[i]);
        const nb = /^\d+$/.test(xb[i]);
        if (na && nb) {
            const d = Number(xa[i]) - Number(xb[i]);
            if (d !== 0) return Math.sign(d);
        } else if (na !== nb) {
            return na ? -1 : 1;
        } else if (xa[i] !== xb[i]) {
            return xa[i] < xb[i] ? -1 : 1;
        }
    }
    return 0;
}

/** `sha384-<base64>` of the bytes (Subresource Integrity). */
export function sha384Integrity(bytes: Uint8Array): string {
    return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

/**
 * The Node server package a plugin needs: `serverPackages.node` (`{ node, dotnet, python }`), or the `npm` entry of
 * the marketplace's list form (`[{ ecosystem: 'npm', name }]`).
 */
export function nodeServerPackage(serverPackages: unknown): string | undefined {
    if (Array.isArray(serverPackages)) {
        const npm = serverPackages.find((p) => p && typeof p === 'object' && (p as { ecosystem?: unknown }).ecosystem === 'npm');
        const name = (npm as { name?: unknown } | undefined)?.name;
        return typeof name === 'string' && name ? name : undefined;
    }
    if (serverPackages && typeof serverPackages === 'object') {
        const node = (serverPackages as { node?: unknown }).node;
        return typeof node === 'string' && node ? node : undefined;
    }
    return undefined;
}

const apiOf = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1);

/** True when a version record is a dashboard bundle (its own `kind`, else the plugin's). */
function isDashboardVersion(v: MarketplaceDashboardVersion, plugin: MarketplaceDashboardItem): boolean {
    return (v.kind ?? plugin.kind) === 'dashboard';
}

/** The newest listed version this dashboard can run; undefined when there is none. */
function latestFitting(plugin: MarketplaceDashboardItem): MarketplaceDashboardVersion | undefined {
    return (plugin.versions ?? [])
        .filter((v) => v && isValidDashboardPluginVersion(v.version) && v.status === 'listed' && isDashboardVersion(v, plugin) && apiOf(v.dashboardApi) <= DASHBOARD_API_VERSION)
        .sort((a, b) => compareDashboardPluginVersions(b.version, a.version))[0];
}

/** The newest listed version, whatever API it needs. */
function latestListed(plugin: MarketplaceDashboardItem): MarketplaceDashboardVersion | undefined {
    return (plugin.versions ?? [])
        .filter((v) => v && isValidDashboardPluginVersion(v.version) && v.status === 'listed' && isDashboardVersion(v, plugin))
        .sort((a, b) => compareDashboardPluginVersions(b.version, a.version))[0];
}

/** The files to store: exactly one `.js` (as `extension.js`) and at most one `.css` (as `extension.css`). */
function plannedFiles(files: unknown): Array<Omit<InstalledDashboardPluginFile, 'size'> & { size?: number }> {
    const invalid = () => new DashboardMarketplaceError(502, 'invalid marketplace record: files');
    if (!Array.isArray(files) || files.length === 0 || files.length > 2) throw invalid();
    const out: Array<Omit<InstalledDashboardPluginFile, 'size'> & { size?: number }> = [];
    for (const f of files as MarketplaceDashboardFile[]) {
        if (!f || typeof f.path !== 'string' || !FILE_PATH.test(f.path) || f.path.split('/').some((s) => s === '.' || s === '..')) throw invalid();
        if (typeof f.integrity !== 'string' || !INTEGRITY.test(f.integrity)) throw invalid();
        const file = f.path.endsWith('.js') ? 'extension.js' : f.path.endsWith('.css') ? 'extension.css' : undefined;
        if (!file || out.some((o) => o.file === file)) throw invalid();
        if (f.size !== undefined && (typeof f.size !== 'number' || f.size < 0)) throw invalid();
        if (typeof f.size === 'number' && f.size > DASHBOARD_PLUGIN_MAX_FILE_BYTES) throw new DashboardMarketplaceError(502, `file too large: ${f.path}`);
        out.push({ file, path: f.path, integrity: f.integrity, ...(typeof f.size === 'number' ? { size: f.size } : {}) });
    }
    if (!out.some((o) => o.file === 'extension.js')) throw invalid();
    return out;
}

/** A served plugin: its record and the handler of its files. */
interface ServedPlugin {
    record: InstalledDashboardPluginRecord;
    handler: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
}

/**
 * Dashboard plugins from the marketplace: browses its `kind=dashboard` catalog, installs, updates and removes plugins
 * (bundles from jsDelivr then unpkg, checked against the marketplace's sha384 before anything is stored), keeps them
 * in `<dir>/<name>/<version>/` with `<dir>/installed.json` (written atomically), registers each as a dashboard
 * extension and serves its files at `/qcli/modules/<id>/`.
 */
export class DashboardMarketplace {
    readonly url: string;
    readonly install: DashboardInstallPolicy;
    readonly dir: string;
    private readonly fetchFn: MarketplaceFetch;
    private readonly cdns: string[];
    private readonly timeoutMs: number;
    private readonly plugins = new Map<string, ServedPlugin>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        options: DashboardMarketplaceOptions,
        private readonly deps: DashboardMarketplaceDeps,
    ) {
        const url = (options.url ?? DEFAULT_MARKETPLACE_URL).trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^/\s]+/i.test(url)) throw new Error(`invalid marketplace url: ${options.url}`);
        const install = options.install ?? 'verified';
        if (!['verified', 'listed', 'off'].includes(install)) throw new Error(`invalid marketplace install policy: ${install}`);
        this.url = url;
        this.install = install;
        this.dir = resolve(options.dir ?? DEFAULT_DASHBOARD_PLUGINS_DIR);
        const fetchFn = options.fetch ?? (globalThis as { fetch?: MarketplaceFetch }).fetch;
        if (!fetchFn) throw new Error('no fetch available: pass marketplace.fetch');
        this.fetchFn = fetchFn;
        this.cdns = (options.cdns ?? [...DEFAULT_DASHBOARD_PLUGIN_CDNS]).map((c) => c.replace(/\/+$/, ''));
        this.timeoutMs = options.timeoutMs ?? 15_000;
    }

    /** `GET /`: the marketplace, the install policy and the dashboard API this server runs. */
    info(): { marketplaceUrl: string; install: DashboardInstallPolicy; dashboardApi: number } {
        return { marketplaceUrl: this.url, install: this.install, dashboardApi: DASHBOARD_API_VERSION };
    }

    /** True when `id` is the page of an installed marketplace plugin. */
    hasExtension(id: string): boolean {
        return this.plugins.has(id);
    }

    // ---------------------------------------------------------------- browsing

    /** `GET /plugins`: the marketplace's dashboard plugins, annotated. Throws 502 when it is unreachable. */
    async search(params: { query?: string; page?: number; pageSize?: number } = {}): Promise<{ items: Array<MarketplaceDashboardItem & DashboardPluginAnnotations>; total: number; page: number; pageSize: number }> {
        const qs = new URLSearchParams({ kind: 'dashboard', dashboardApi: String(DASHBOARD_API_VERSION) });
        if (params.query?.trim()) qs.set('query', params.query.trim().slice(0, 200));
        if (params.page !== undefined) qs.set('page', String(params.page));
        if (params.pageSize !== undefined) qs.set('pageSize', String(params.pageSize));
        const body = (await this.getJson(`/plugins?${qs}`)) as { items?: unknown; total?: unknown; page?: unknown; pageSize?: unknown } | undefined;
        if (!body || !Array.isArray(body.items)) throw new DashboardMarketplaceError(502, 'marketplace unreachable');
        // Only dashboard plugins, whatever an older marketplace sends
        const items = (body.items as MarketplaceDashboardItem[]).filter((i) => i && isValidDashboardPluginName(i.name) && i.kind === 'dashboard');
        return {
            items: items.map((item) => ({ ...item, ...this.annotate(item) })),
            total: typeof body.total === 'number' ? body.total : items.length,
            page: typeof body.page === 'number' ? body.page : (params.page ?? 1),
            pageSize: typeof body.pageSize === 'number' ? body.pageSize : (params.pageSize ?? items.length),
        };
    }

    /** `GET /plugins/{name}`: one plugin with its versions, annotated. Throws 404 or 502. */
    async details(name: string): Promise<MarketplaceDashboardItem & DashboardPluginAnnotations> {
        const plugin = await this.fetchPlugin(name);
        const versions = (plugin.versions ?? []).map((v) => {
            const reason = this.versionBlockedReason(plugin, v);
            return { ...v, allowed: !reason, ...(reason ? { blockedReason: reason } : {}) };
        });
        return { ...plugin, versions, ...this.annotate(plugin) };
    }

    /** The annotations of a list item or a plugin's details. */
    private annotate(item: MarketplaceDashboardItem): DashboardPluginAnnotations {
        const installed = this.recordOf(item.name);
        let latest: string | null | undefined;
        let api: number;
        if (Array.isArray(item.versions)) {
            const fitting = latestFitting(item);
            latest = fitting?.version;
            api = fitting ? apiOf(fitting.dashboardApi) : apiOf(latestListed(item)?.dashboardApi);
        } else {
            latest = item.version ?? item.latest;
            api = apiOf(item.dashboardApi);
        }
        const blockedReason = this.blockedReason(item, api);
        const serverPackage = nodeServerPackage(item.serverPackages);
        return {
            installed: installed ? { version: installed.version } : null,
            updateAvailable: !!installed && typeof latest === 'string' && isValidDashboardPluginVersion(latest) && compareDashboardPluginVersions(latest, installed.version) > 0,
            allowed: !blockedReason,
            ...(blockedReason ? { blockedReason } : {}),
            requires: serverPackage ? { serverPackage, installed: this.deps.serverPlugins().some((p) => p.id === serverPackage) } : null,
        };
    }

    /** Why the trust policy or the API refuses a plugin: `install disabled`, `unverified publisher`, `needs dashboard API <n>`. */
    private blockedReason(item: MarketplaceDashboardItem, api: number): string | undefined {
        if (this.install === 'off') return 'install disabled';
        if (this.install === 'verified' && item.publisher?.verified !== true) return 'unverified publisher';
        if (api > DASHBOARD_API_VERSION) return `needs dashboard API ${api}`;
        return undefined;
    }

    private versionBlockedReason(plugin: MarketplaceDashboardItem, v: MarketplaceDashboardVersion): string | undefined {
        const reason = this.blockedReason(plugin, apiOf(v.dashboardApi));
        if (reason) return reason;
        if (!isDashboardVersion(v, plugin)) return 'not a dashboard plugin';
        if (v.status !== 'listed') return `version ${v.status ?? 'not listed'}`;
        return undefined;
    }

    /** GETs a path of the marketplace's public API: its JSON, undefined for a 404, 502 `marketplace unreachable` otherwise. */
    private async getJson(path: string): Promise<unknown> {
        let res: MarketplaceFetchResponse;
        try {
            res = await this.fetchFn(`${this.url}${MARKETPLACE_API_PATH}${path}`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch {
            throw new DashboardMarketplaceError(502, 'marketplace unreachable');
        }
        if (res.status === 404) return undefined;
        if (!res.ok) throw new DashboardMarketplaceError(502, 'marketplace unreachable');
        try {
            return await res.json();
        } catch {
            throw new DashboardMarketplaceError(502, 'marketplace unreachable');
        }
    }

    /** A plugin's details with its versions. Throws 400 for an invalid name, 404 when the marketplace does not list it. */
    private async fetchPlugin(name: string): Promise<MarketplaceDashboardItem> {
        if (!isValidDashboardPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid package name');
        const plugin = (await this.getJson(`/plugins/${encodeURIComponent(name)}`)) as MarketplaceDashboardItem | undefined;
        if (!plugin || typeof plugin !== 'object') throw new DashboardMarketplaceError(404, `plugin not found: ${name}`);
        if (plugin.name !== name) throw new DashboardMarketplaceError(502, 'marketplace unreachable');
        return { ...plugin, versions: Array.isArray(plugin.versions) ? plugin.versions : [] };
    }

    // ---------------------------------------------------------------- installed

    /** The installed plugins, in installation order. */
    records(): InstalledDashboardPluginRecord[] {
        return [...this.plugins.values()].map((p) => ({ ...p.record, files: p.record.files.map((f) => ({ ...f })) }));
    }

    private recordOf(name: string): InstalledDashboardPluginRecord | undefined {
        for (const p of this.plugins.values()) if (p.record.name === name) return p.record;
        return undefined;
    }

    /**
     * `GET /installed`: the installed plugins; with `checkUpdates`, `updateAvailable` from the marketplace (left out of
     * a plugin the marketplace does not answer for).
     */
    async installed(options: { checkUpdates?: boolean } = {}): Promise<InstalledDashboardPlugin[]> {
        const records = this.records();
        return Promise.all(
            records.map(async (r) => {
                const view = installedView(r);
                if (!options.checkUpdates) return view;
                try {
                    const latest = latestFitting(await this.fetchPlugin(r.name))?.version;
                    return { ...view, updateAvailable: !!latest && compareDashboardPluginVersions(latest, r.version) > 0 };
                } catch {
                    return view;
                }
            }),
        );
    }

    // ---------------------------------------------------------------- changes

    /** `POST /installed`: installs `name` (the newest fitting version when `version` is absent). 201 with the plugin. */
    installPlugin(name: unknown, version: unknown, actor: DashboardMarketplaceActor): Promise<InstalledDashboardPlugin> {
        return this.exclusive(async () => {
            if (!isValidDashboardPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid package name');
            if (version !== undefined && version !== null && !isValidDashboardPluginVersion(version)) throw new DashboardMarketplaceError(400, 'invalid version');
            const existing = this.recordOf(name);
            if (existing) throw new DashboardMarketplaceError(409, `already installed: ${name}@${existing.version}`);
            const { plugin, target } = await this.resolve(name, (version as string | null | undefined) ?? undefined);
            const id = dashboardPluginId(name, target.extension?.id ?? plugin.extension?.id);
            if (!id) throw new DashboardMarketplaceError(400, `no dashboard extension id for ${name}`);
            if (this.deps.extensions.list().some((e) => e.id === id)) throw new DashboardMarketplaceError(409, `dashboard extension already registered: ${id}`);
            const record = await this.store(name, target, id, plugin, actor);
            try {
                this.register(record);
            } catch (err) {
                await rm(this.versionDir(name, target.version), { recursive: true, force: true });
                throw new DashboardMarketplaceError(409, (err as Error).message);
            }
            await this.save();
            await this.changed('install', record, actor);
            return installedView(record);
        });
    }

    /** `PUT /installed/{name}`: updates to `version` (default: the newest fitting one). `changed` is false when it already is that version. */
    updatePlugin(name: unknown, version: unknown, actor: DashboardMarketplaceActor): Promise<{ plugin: InstalledDashboardPlugin; changed: boolean; previousVersion: string }> {
        return this.exclusive(async () => {
            if (!isValidDashboardPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid package name');
            if (version !== undefined && version !== null && !isValidDashboardPluginVersion(version)) throw new DashboardMarketplaceError(400, 'invalid version');
            const current = this.recordOf(name);
            if (!current) throw new DashboardMarketplaceError(404, `not installed: ${name}`);
            const { plugin, target } = await this.resolve(name, (version as string | null | undefined) ?? undefined);
            if (target.version === current.version) return { plugin: installedView(current), changed: false, previousVersion: current.version };
            // The page keeps its id, so open dashboards and links keep working
            const record = await this.store(name, target, current.id, plugin, actor);
            record.installedAt = new Date().toISOString();
            this.unregister(current.id);
            try {
                this.register(record);
            } catch (err) {
                this.register(current);
                await rm(this.versionDir(name, target.version), { recursive: true, force: true });
                throw new DashboardMarketplaceError(409, (err as Error).message);
            }
            await this.save();
            await rm(this.versionDir(name, current.version), { recursive: true, force: true });
            await this.changed('update', record, actor, current.version);
            return { plugin: installedView(record), changed: true, previousVersion: current.version };
        });
    }

    /** `DELETE /installed/{name}`: unregisters the page and deletes its files. */
    removePlugin(name: unknown, actor: DashboardMarketplaceActor): Promise<InstalledDashboardPlugin> {
        return this.exclusive(async () => {
            if (!isValidDashboardPluginName(name)) throw new DashboardMarketplaceError(400, 'invalid package name');
            const current = this.recordOf(name);
            if (!current) throw new DashboardMarketplaceError(404, `not installed: ${name}`);
            this.unregister(current.id);
            await this.save();
            await rm(join(this.dir, dashboardPluginDirName(name)), { recursive: true, force: true });
            await this.changed('remove', current, actor);
            return installedView(current);
        });
    }

    /** Runs changes one at a time. */
    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** The plugin and the version to install, after the kind, trust policy and API checks. */
    private async resolve(name: string, version: string | undefined): Promise<{ plugin: MarketplaceDashboardItem; target: MarketplaceDashboardVersion }> {
        const plugin = await this.fetchPlugin(name);
        if (plugin.kind !== 'dashboard') throw new DashboardMarketplaceError(400, `not a dashboard plugin: ${name}`);
        if (this.install === 'off') throw new DashboardMarketplaceError(403, 'install disabled');
        if (this.install === 'verified' && plugin.publisher?.verified !== true) throw new DashboardMarketplaceError(403, 'publisher not verified');
        let target: MarketplaceDashboardVersion | undefined;
        if (version) {
            target = (plugin.versions ?? []).find((v) => v?.version === version);
            if (!target || target.status !== 'listed') throw new DashboardMarketplaceError(404, `version not found: ${name}@${version}`);
            if (!isDashboardVersion(target, plugin)) throw new DashboardMarketplaceError(400, `not a dashboard plugin: ${name}@${version}`);
            const api = apiOf(target.dashboardApi);
            if (api > DASHBOARD_API_VERSION) throw new DashboardMarketplaceError(400, `needs dashboard API ${api}`);
        } else {
            target = latestFitting(plugin);
            if (!target) {
                const newest = latestListed(plugin);
                if (newest) throw new DashboardMarketplaceError(400, `needs dashboard API ${apiOf(newest.dashboardApi)}`);
                throw new DashboardMarketplaceError(404, `no installable version: ${name}`);
            }
        }
        if (!Array.isArray(target.files)) {
            // An older details view without files: the version record has them
            const record = (await this.getJson(`/plugins/${encodeURIComponent(name)}/versions/${encodeURIComponent(target.version)}`)) as MarketplaceDashboardVersion | undefined;
            if (!record) throw new DashboardMarketplaceError(404, `version not found: ${name}@${target.version}`);
            target = { ...target, files: record.files };
        }
        return { plugin, target };
    }

    /** Downloads and verifies every file, then stores them in `<dir>/<name>/<version>/` (staged, then renamed into place). */
    private async store(
        name: string,
        target: MarketplaceDashboardVersion,
        id: string,
        plugin: MarketplaceDashboardItem,
        actor: DashboardMarketplaceActor,
    ): Promise<InstalledDashboardPluginRecord> {
        const planned = plannedFiles(target.files);
        const downloaded: Array<{ file: InstalledDashboardPluginFile; bytes: Uint8Array }> = [];
        for (const f of planned) {
            const bytes = await this.download(name, target.version, f.path, f.integrity);
            downloaded.push({ file: { file: f.file, path: f.path, integrity: f.integrity, size: bytes.byteLength }, bytes });
        }
        // Verified: now write
        await mkdir(this.dir, { recursive: true });
        const staging = join(this.dir, `.staging-${randomBytes(6).toString('hex')}`);
        const final = this.versionDir(name, target.version);
        try {
            await mkdir(staging);
            for (const d of downloaded) await writeFile(join(staging, d.file.file), d.bytes);
            await mkdir(join(this.dir, dashboardPluginDirName(name)), { recursive: true });
            await rm(final, { recursive: true, force: true });
            await rename(staging, final);
        } catch (err) {
            await rm(staging, { recursive: true, force: true });
            throw err;
        }
        const icon = typeof plugin.icon === 'string' ? plugin.icon : undefined;
        const titleSource = [plugin.title, plugin.shortName, name].find((t) => typeof t === 'string' && t.trim().length > 0) as string;
        return {
            name,
            version: target.version,
            id,
            title: titleSource.trim().slice(0, 40),
            ...(icon ? { icon } : {}),
            files: downloaded.map((d) => d.file),
            installedAt: new Date().toISOString(),
            installedBy: actor.userName,
        };
    }

    /** One file from the first CDN whose bytes match `integrity`. Throws 502 `integrity mismatch` or `download failed`. */
    private async download(name: string, version: string, path: string, integrity: string): Promise<Uint8Array> {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        let mismatch = false;
        for (const cdn of this.cdns) {
            const url = `${cdn}/${name}@${encodeURIComponent(version)}/${encodedPath}`;
            let bytes: Uint8Array;
            try {
                const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
                if (!res.ok) continue;
                const length = Number(res.headers.get('content-length'));
                if (Number.isFinite(length) && length > DASHBOARD_PLUGIN_MAX_FILE_BYTES) continue;
                bytes = new Uint8Array(await res.arrayBuffer());
            } catch {
                continue;
            }
            if (bytes.byteLength > DASHBOARD_PLUGIN_MAX_FILE_BYTES) continue;
            if (sha384Integrity(bytes) === integrity) return bytes;
            mismatch = true;
        }
        throw new DashboardMarketplaceError(502, mismatch ? `integrity mismatch: ${path}` : `download failed: ${path}`);
    }

    private versionDir(name: string, version: string): string {
        const dir = resolve(this.dir, dashboardPluginDirName(name), version);
        // Valid names and versions never leave the directory; checked all the same
        if (!dir.startsWith(this.dir + sep) || !isValidDashboardPluginVersion(version)) throw new DashboardMarketplaceError(400, 'invalid version');
        return dir;
    }

    /** Serves the plugin's files and adds its page. Throws when the id is taken. */
    private register(record: InstalledDashboardPluginRecord): void {
        const page = dashboardModulePage(this.versionDir(record.name, record.version), {
            id: record.id,
            title: record.title,
            ...(record.icon ? { icon: record.icon } : {}),
            version: record.version,
        });
        let extension: CliDashboardExtension;
        try {
            extension = validateDashboardExtension(page.extension);
        } catch {
            // An icon the dashboard cannot show is left out
            const { icon: _icon, ...rest } = page.extension;
            extension = validateDashboardExtension(rest);
        }
        this.deps.extensions.add(extension);
        this.plugins.set(record.id, { record, handler: page.handler });
    }

    private unregister(id: string): void {
        this.deps.extensions.remove(id);
        this.plugins.delete(id);
    }

    /** Writes `installed.json` atomically (a temporary file renamed over it). */
    private async save(): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        const file = join(this.dir, INSTALLED_FILE);
        const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        const body = JSON.stringify({ plugins: [...this.plugins.values()].map((p) => p.record) }, null, 2) + '\n';
        try {
            await writeFile(temp, body, { mode: 0o600 });
            await rename(temp, file);
        } catch (err) {
            await rm(temp, { force: true });
            throw err;
        }
    }

    private async changed(action: 'install' | 'update' | 'remove', record: InstalledDashboardPluginRecord, actor: DashboardMarketplaceActor, previousVersion?: string): Promise<void> {
        const sink = this.deps.audit?.();
        if (sink) {
            try {
                await sink({
                    timestamp: Date.now(),
                    event: `dashboard.plugin.${action}`,
                    username: actor.userName,
                    ...(actor.userId ? { userId: actor.userId, actorId: actor.userId } : {}),
                    actor: actor.userName,
                    target: record.name,
                    details: previousVersion ? `${record.name} ${previousVersion} -> ${record.version}` : `${record.name}@${record.version}`,
                    properties: { name: record.name, version: record.version, id: record.id, ...(previousVersion ? { previousVersion } : {}) },
                });
            } catch (err) {
                console.error('[qcli-admin] audit of a dashboard plugin change failed:', (err as Error)?.message ?? err);
            }
        }
        this.deps.publish?.(DASHBOARD_EXTENSIONS_CHANGED_EVENT, {
            action,
            name: record.name,
            version: record.version,
            id: record.id,
            ...(previousVersion ? { previousVersion } : {}),
        });
    }

    // ---------------------------------------------------------------- startup and serving

    /**
     * Registers the plugins `installed.json` lists (at startup). A plugin whose files are missing or changed on disk,
     * or whose id is taken, is skipped with a warning; a broken `installed.json` loads nothing.
     */
    load(): void {
        const file = join(this.dir, INSTALLED_FILE);
        if (!existsSync(file)) return;
        let records: unknown;
        try {
            records = (JSON.parse(readFileSync(file, 'utf8')) as { plugins?: unknown }).plugins;
        } catch (err) {
            console.warn(`[qcli-admin] ${file} is not readable JSON, no dashboard plugins loaded:`, (err as Error).message);
            return;
        }
        if (!Array.isArray(records)) return;
        for (const raw of records as InstalledDashboardPluginRecord[]) {
            const label = `${raw?.name}@${raw?.version}`;
            try {
                if (!isValidDashboardPluginName(raw?.name) || !isValidDashboardPluginVersion(raw?.version) || typeof raw.id !== 'string' || !EXTENSION_ID.test(raw.id)) {
                    throw new Error('invalid record');
                }
                if (this.recordOf(raw.name)) throw new Error('listed twice');
                const files = plannedFiles(raw.files?.map((f) => ({ path: f?.path, integrity: f?.integrity })));
                const dir = this.versionDir(raw.name, raw.version);
                for (const f of files) {
                    const path = join(dir, f.file);
                    if (!existsSync(path) || sha384Integrity(readFileSync(path)) !== f.integrity) throw new Error(`${f.file} is missing or changed on disk`);
                }
                if (this.deps.extensions.list().some((e) => e.id === raw.id)) throw new Error(`dashboard extension already registered: ${raw.id}`);
                const record: InstalledDashboardPluginRecord = {
                    name: raw.name,
                    version: raw.version,
                    id: raw.id,
                    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 40) : raw.name.slice(0, 40),
                    ...(typeof raw.icon === 'string' ? { icon: raw.icon } : {}),
                    files: raw.files.map((f) => ({ file: f.file, path: f.path, integrity: f.integrity, size: f.size })),
                    installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : '',
                    installedBy: typeof raw.installedBy === 'string' ? raw.installedBy : '',
                };
                this.register(record);
            } catch (err) {
                console.warn(`[qcli-admin] dashboard plugin ${label} not loaded: ${(err as Error).message}`);
            }
        }
    }

    /**
     * Serves the installed plugins' files below `/qcli/modules` (`/<id>/extension.js`, `/<id>/extension.css`); anything
     * else goes to `next`.
     */
    readonly handler = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
        const url = req.url ?? '/';
        const match = /^\/([a-z0-9][a-z0-9-]{0,39})(\/[^?]*)?(\?.*)?$/.exec(url);
        const plugin = match ? this.plugins.get(match[1]) : undefined;
        if (!match || !plugin) {
            next();
            return;
        }
        req.url = `${match[2] ?? '/'}${match[3] ?? ''}`;
        plugin.handler(req, res, (err?: unknown) => {
            req.url = url;
            next(err);
        });
    };
}

function installedView(r: InstalledDashboardPluginRecord): InstalledDashboardPlugin {
    return { name: r.name, version: r.version, title: r.title, icon: r.icon ?? null, id: r.id, installedAt: r.installedAt, installedBy: r.installedBy };
}
