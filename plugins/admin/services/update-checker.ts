import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import {
    CLI_UPDATES_READ_PERMISSION,
    CliNotificationKeys,
    type CliUpdateItem,
    type CliUpdatesResult,
    type ICliJob,
    type ICliNotifications,
} from '@qodalis/cli-server-abstractions';
import { compareDashboardPluginVersions, type DashboardMarketplace, type MarketplaceFetch, type MarketplaceFetchResponse } from './dashboard-marketplace';
import { SERVER_CORE_PACKAGE, SERVER_PLUGIN_PLATFORM, type ServerPluginMarketplace } from './server-plugin-marketplace';

/** How often the server checks for updates. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 3_600_000;
/** The first check after a start (unless the last result is fresher than the interval). */
export const UPDATE_CHECK_INITIAL_DELAY_MS = 60_000;
/** The job id when the jobs plugin schedules the check. */
export const UPDATE_CHECK_JOB_ID = 'updates:check';
/** The file the last result is kept in, below the data directory. */
export const UPDATES_FILE = 'updates.json';
/** The dashboard tab the update notifications open. */
export const UPDATES_LINK = '/plugins?tab=updates';
/** Most marketplace pages read per kind (100 plugins each). */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

/** The `updates` option of the admin builder (`setUpdateChecks`). */
export interface UpdateCheckOptions {
    /** Check periodically (default true); "Check now" works either way. */
    enabled?: boolean;
    /** Between checks (default 6 hours). */
    intervalMs?: number;
    /** The first check after a start (default 60 s; a fresher last result waits until it is due). */
    initialDelayMs?: number;
}

/** The part of the jobs plugin's scheduler the checker uses. */
export interface UpdateCheckScheduler {
    register(job: ICliJob, options: { id: string; name: string; description: string; group: string; tags: string[]; interval: string }): string;
    getRegistration?(id: string): unknown;
}

export interface UpdateCheckerDeps {
    dashboard?: DashboardMarketplace;
    server?: ServerPluginMarketplace;
    /** The running server's version (`@qodalis/cli-server-node`). */
    serverVersion: () => string | null;
    /** Where the server package's newest version is read (`<registry>/<package>/latest`). */
    npmRegistry: string;
    fetch: MarketplaceFetch;
    timeoutMs?: number;
    notifications?: () => ICliNotifications | undefined;
    /** The jobs plugin's scheduler when one is mounted (read when the checks start). */
    scheduler?: () => UpdateCheckScheduler | undefined;
    /** The file the last result is kept in (none: memory only). */
    file?: string;
    now?: () => Date;
}

const emptyResult = (): CliUpdatesResult => ({ checkedAt: null, checking: false, server: null, dashboardPlugins: [], serverPlugins: [], codePlugins: [], count: 0 });

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** `update:dashboard:<name>`, `update:server:<name>`, `update:code:<kind>:<package>`, `update:core:<package>`. */
export function updateNotificationKey(item: Pick<CliUpdateItem, 'kind' | 'name' | 'package' | 'source'>): string {
    if (item.kind === 'core') return `${CliNotificationKeys.UpdatePrefix}core:${item.package}`;
    if (item.source === 'code') return `${CliNotificationKeys.UpdatePrefix}code:${item.kind}:${item.package}`;
    return `${CliNotificationKeys.UpdatePrefix}${item.kind}:${item.name}`;
}

/** The install commands per platform of a marketplace server plugin (this server's first, at the version given). */
function installCommands(platforms: unknown, own: { package: string; latest: string | null }): Record<string, string> {
    const list: Array<Record<string, unknown>> = Array.isArray(platforms)
        ? (platforms as Array<Record<string, unknown>>)
        : platforms && typeof platforms === 'object'
          ? Object.entries(platforms as Record<string, Record<string, unknown>>).map(([platform, p]) => ({ ...(p ?? {}), platform }))
          : [];
    const out: Record<string, string> = { [SERVER_PLUGIN_PLATFORM]: `npm install ${own.package}${own.latest ? `@${own.latest}` : ''}` };
    for (const p of list) {
        const platform = text(p.platform);
        const pkg = text(p.package);
        if (!platform || platform === SERVER_PLUGIN_PLATFORM || !pkg) continue;
        const latest = text(p.latest);
        out[platform] =
            text(p.install) ??
            (platform === 'python'
                ? `pip install --upgrade ${pkg}${latest ? `==${latest}` : ''}`
                : platform === 'dotnet'
                  ? `dotnet add package ${pkg}${latest ? ` --version ${latest}` : ''}`
                  : `${pkg}${latest ? `@${latest}` : ''}`);
    }
    return out;
}

/**
 * Checks the marketplace (and npm for the server package) for newer versions: dashboard and server plugins installed
 * from the marketplace (updated here), plugins the host adds in code (updated in code), and the server package. Every
 * update becomes a notification (`update:…`, permission `updates:read`) resolved once it no longer applies. Runs every
 * 6 hours (a job of the jobs plugin when one is mounted, else a timer) and on demand (`POST /updates/check`); the last
 * result is kept in `<dataDir>/updates.json`.
 */
export class UpdateChecker {
    private last: CliUpdatesResult = emptyResult();
    private running?: Promise<CliUpdatesResult>;
    private timers: NodeJS.Timeout[] = [];
    private started = false;
    private readonly now: () => Date;

    constructor(
        private readonly deps: UpdateCheckerDeps,
        private readonly options: UpdateCheckOptions = {},
    ) {
        this.now = deps.now ?? (() => new Date());
        this.last = this.readFile() ?? emptyResult();
    }

    /** The last result (`GET /updates`). */
    result(): CliUpdatesResult {
        return { ...JSON.parse(JSON.stringify(this.last)), checking: !!this.running } as CliUpdatesResult;
    }

    /** Checks now; a check already running is joined. */
    check(): Promise<CliUpdatesResult> {
        this.running ??= this.run().finally(() => {
            this.running = undefined;
        });
        return this.running.then(() => this.result());
    }

    /**
     * Starts the periodic checks: the first after `initialDelayMs` (or when the last result is due), then every
     * `intervalMs`, through the jobs plugin's scheduler when there is one.
     */
    start(): void {
        if (this.started || this.options.enabled === false) return;
        this.started = true;
        const interval = this.options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
        const age = this.last.checkedAt ? this.now().getTime() - Date.parse(this.last.checkedAt) : Infinity;
        const first = Math.max(this.options.initialDelayMs ?? UPDATE_CHECK_INITIAL_DELAY_MS, Number.isFinite(age) ? interval - age : 0);
        const firstTimer = setTimeout(() => void this.check().catch(() => undefined), first);
        firstTimer.unref?.();
        this.timers.push(firstTimer);
        const scheduler = this.deps.scheduler?.();
        if (scheduler && interval % 1000 === 0) {
            try {
                if (!scheduler.getRegistration?.(UPDATE_CHECK_JOB_ID)) {
                    scheduler.register(
                        {
                            executeAsync: async (context) => {
                                const result = await this.check();
                                context.logger.info(`${result.count} update(s) available${result.error ? ` (${result.error})` : ''}`);
                                if (result.error) throw new Error(result.error);
                            },
                        },
                        {
                            id: UPDATE_CHECK_JOB_ID,
                            name: UPDATE_CHECK_JOB_ID,
                            description: 'Checks the marketplace and npm for newer versions of the plugins and the server',
                            group: 'system',
                            tags: ['system', 'updates'],
                            interval: `${Math.round(interval / 1000)}s`,
                        },
                    );
                }
                return;
            } catch {
                // the scheduler refused it: a timer instead
            }
        }
        const timer = setInterval(() => void this.check().catch(() => undefined), interval);
        timer.unref?.();
        this.timers.push(timer);
    }

    stop(): void {
        for (const t of this.timers.splice(0)) clearTimeout(t);
        this.started = false;
    }

    /**
     * After an install, update or removal: drops the marketplace updates whose installed version caught up (or that
     * were removed) and resolves their notifications, without asking the marketplace again.
     */
    refreshInstalled(): void {
        const installedDashboard = new Map((this.deps.dashboard?.records() ?? []).map((r) => [r.name, r.version]));
        const installedServer = new Map((this.deps.server ? this.deps.server.installedRecords() : []).map((r) => [r.name, r.version]));
        const stale = (item: CliUpdateItem, versions: Map<string, string>) => {
            const current = versions.get(item.name);
            return !current || !item.latest || compareDashboardPluginVersions(item.latest, current) <= 0;
        };
        const gone = [
            ...this.last.dashboardPlugins.filter((i) => stale(i, installedDashboard)),
            ...this.last.serverPlugins.filter((i) => stale(i, installedServer)),
        ];
        if (gone.length === 0) return;
        this.last.dashboardPlugins = this.last.dashboardPlugins.filter((i) => !gone.includes(i));
        this.last.serverPlugins = this.last.serverPlugins.filter((i) => !gone.includes(i));
        this.last.count = countOf(this.last);
        const notifications = this.deps.notifications?.();
        for (const item of gone) notifications?.resolve(updateNotificationKey(item));
        this.save();
    }

    private async run(): Promise<CliUpdatesResult> {
        const errors: string[] = [];
        // The categories that answered: only their notifications are resolved
        const answered: string[] = [];
        const next: CliUpdatesResult = { ...emptyResult(), checkedAt: null };
        const prefix = CliNotificationKeys.UpdatePrefix;

        if (this.deps.dashboard) {
            try {
                for (const item of await this.dashboardItems()) {
                    if (!item.installed || !item.updateAvailable) continue;
                    const latest = text(item.version) ?? text(item.latest) ?? null;
                    const base = {
                        kind: 'dashboard' as const,
                        name: item.name,
                        package: item.name,
                        title: text(item.title) ?? item.name,
                        icon: text(item.icon) ?? null,
                        current: item.installed.version,
                        latest,
                        updateAvailable: true,
                    };
                    if (item.installed.source === 'marketplace') {
                        next.dashboardPlugins.push({ ...base, source: 'marketplace', canUpdate: item.allowed, ...(item.blockedReason ? { reason: item.blockedReason } : {}) });
                    } else {
                        next.codePlugins.push({ ...base, source: 'code', canUpdate: false, reason: 'update in code', install: { [SERVER_PLUGIN_PLATFORM]: `npm install ${item.name}${latest ? `@${latest}` : ''}` } });
                    }
                }
                answered.push(`${prefix}dashboard:`, `${prefix}code:dashboard:`);
            } catch (err) {
                errors.push(`dashboard plugins: ${(err as Error).message}`);
            }
        }

        if (this.deps.server) {
            try {
                for (const item of await this.serverItems()) {
                    if (!item.installed || !item.updateAvailable || !item.platform) continue;
                    const base = {
                        kind: 'server' as const,
                        name: item.name,
                        package: item.platform.package,
                        title: text(item.title) ?? item.name,
                        icon: text(item.icon) ?? null,
                        current: item.installed.version,
                        latest: item.platform.latest,
                        updateAvailable: true,
                    };
                    if (item.installed.source === 'marketplace') {
                        next.serverPlugins.push({ ...base, source: 'marketplace', canUpdate: item.allowed, ...(item.blockedReason ? { reason: item.blockedReason } : {}) });
                    } else {
                        next.codePlugins.push({
                            ...base,
                            source: 'code',
                            canUpdate: false,
                            reason: 'update in code',
                            install: installCommands(item.platforms, { package: item.platform.package, latest: item.platform.latest }),
                        });
                    }
                }
                answered.push(`${prefix}server:`, `${prefix}code:server:`);
            } catch (err) {
                errors.push(`server plugins: ${(err as Error).message}`);
            }
        }

        const current = this.deps.serverVersion();
        try {
            const latest = await this.npmLatest(SERVER_CORE_PACKAGE);
            const updateAvailable = !!current && !!latest && compareDashboardPluginVersions(latest, current) > 0;
            next.server = {
                kind: 'core',
                name: SERVER_CORE_PACKAGE,
                package: SERVER_CORE_PACKAGE,
                title: 'Server',
                current,
                latest,
                source: 'npm',
                updateAvailable,
                canUpdate: false,
                reason: 'update the server packages in code (every @qodalis/cli-server-* package shares the version)',
                install: { [SERVER_PLUGIN_PLATFORM]: `npm install ${SERVER_CORE_PACKAGE}${latest ? `@${latest}` : ''}` },
            };
            answered.push(`${prefix}core:`);
        } catch (err) {
            errors.push(`server package: ${(err as Error).message}`);
            next.server = this.last.server ? { ...this.last.server, current } : null;
        }

        // A category that did not answer keeps its last items
        if (!answered.includes(`${prefix}dashboard:`)) {
            next.dashboardPlugins = this.last.dashboardPlugins;
            next.codePlugins.push(...this.last.codePlugins.filter((i) => i.kind === 'dashboard'));
        }
        if (!answered.includes(`${prefix}server:`)) {
            next.serverPlugins = this.last.serverPlugins;
            next.codePlugins.push(...this.last.codePlugins.filter((i) => i.kind === 'server'));
        }
        next.checkedAt = this.now().toISOString();
        if (errors.length) next.error = errors.join('; ');
        next.count = countOf(next);
        this.last = next;
        this.save();
        this.publish(next, answered);
        return next;
    }

    /** One notification per update; those of the categories that answered and no longer apply are resolved. */
    private publish(result: CliUpdatesResult, answered: string[]): void {
        const notifications = this.deps.notifications?.();
        if (!notifications) return;
        const items = [...result.dashboardPlugins, ...result.serverPlugins, ...result.codePlugins, ...(result.server?.updateAvailable ? [result.server] : [])];
        const keys: string[] = [];
        for (const item of items) {
            const key = updateNotificationKey(item);
            keys.push(key);
            const versions = `${item.current ?? '?'} → ${item.latest ?? '?'}`;
            const title =
                item.kind === 'core'
                    ? `Server update available: ${item.latest}`
                    : item.source === 'code'
                      ? `Update in code: ${item.title} ${item.latest}`
                      : `Update available: ${item.title} ${item.latest}`;
            const message =
                item.kind === 'core'
                    ? `${item.package} ${versions}. Update the server packages in code and restart.`
                    : item.source === 'code'
                      ? `${item.package} ${versions}. The host adds it in code: ${Object.values(item.install ?? {})[0] ?? 'update its package'}, then restart.`
                      : `${item.package} ${versions}.${item.canUpdate ? '' : ` ${item.reason ?? ''}`}`.trim();
            try {
                notifications.notify({
                    key,
                    kind: 'update',
                    severity: 'info',
                    title: title.slice(0, 200),
                    message,
                    link: UPDATES_LINK,
                    requiredPermission: CLI_UPDATES_READ_PERMISSION,
                    data: { kind: item.kind, name: item.name, package: item.package, current: item.current, latest: item.latest, source: item.source, canUpdate: item.canUpdate },
                });
            } catch {
                // an item the notification rules refuse (a huge name): listed by GET /updates all the same
            }
        }
        for (const p of answered) notifications.resolveMissing(p, keys);
    }

    private async dashboardItems() {
        const all = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const res = await this.deps.dashboard!.search({ page, pageSize: PAGE_SIZE });
            all.push(...res.items);
            if (res.items.length === 0 || all.length >= res.total) break;
        }
        return all;
    }

    private async serverItems() {
        const all = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const res = await this.deps.server!.search({ page, pageSize: PAGE_SIZE, platform: 'this' });
            all.push(...res.items);
            if (res.items.length === 0 || all.length >= res.total) break;
        }
        return all;
    }

    /** `dist-tags.latest` of a package on the npm registry (`<registry>/<package>/latest`). */
    private async npmLatest(pkg: string): Promise<string | null> {
        const url = `${this.deps.npmRegistry}/${pkg.replace('/', '%2f')}/latest`;
        let res: MarketplaceFetchResponse;
        try {
            res = await this.deps.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000) });
        } catch {
            throw new Error('npm registry unreachable');
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('npm registry unreachable');
        const body = (await res.json().catch(() => undefined)) as { version?: unknown } | undefined;
        return text(body?.version) ?? null;
    }

    private readFile(): CliUpdatesResult | undefined {
        const file = this.deps.file;
        if (!file || !existsSync(file)) return undefined;
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CliUpdatesResult>;
            if (!parsed || typeof parsed !== 'object') return undefined;
            const list = (v: unknown) => (Array.isArray(v) ? (v as CliUpdateItem[]) : []);
            const result: CliUpdatesResult = {
                checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null,
                checking: false,
                ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
                server: parsed.server && typeof parsed.server === 'object' ? parsed.server : null,
                dashboardPlugins: list(parsed.dashboardPlugins),
                serverPlugins: list(parsed.serverPlugins),
                codePlugins: list(parsed.codePlugins),
                count: 0,
            };
            // The running version may have changed since (an update applied in code)
            if (result.server) {
                const current = this.deps.serverVersion();
                result.server = {
                    ...result.server,
                    current,
                    updateAvailable: !!current && !!result.server.latest && compareDashboardPluginVersions(result.server.latest, current) > 0,
                };
            }
            result.count = countOf(result);
            return result;
        } catch {
            return undefined;
        }
    }

    private save(): void {
        const file = this.deps.file;
        if (!file) return;
        const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
            mkdirSync(dirname(file), { recursive: true });
            const { checking: _c, ...rest } = this.last;
            writeFileSync(tmp, JSON.stringify(rest, null, 2));
            renameSync(tmp, file);
        } catch {
            // an unwritable data directory: the result stays in memory
        }
    }
}

function countOf(r: CliUpdatesResult): number {
    return r.dashboardPlugins.length + r.serverPlugins.length + r.codePlugins.length + (r.server?.updateAvailable ? 1 : 0);
}
