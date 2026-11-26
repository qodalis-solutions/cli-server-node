/**
 * The fake marketplace and CDN of the dashboard marketplace tests (no network), and servers with the admin plugin
 * pointed at them: password sign-in ({@link start}) or a protected server through the users plugin ({@link startProtected}).
 */
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import type { AuditEntry, CliEvent } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult, type CliServerConfigOptions } from '../create-cli-server';
import { CliAdminBuilder, CliAdminPluginResult, DashboardInstallPolicy, MarketplaceFetch, compareDashboardPluginVersions } from '../../plugins/admin/index';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { ROOT_PASS, V1 } from './command-test-helpers';

export const MARKET = 'https://market.test';
export const API = `${MARKET}/api/v1/qcli/marketplace`;
export const JSDELIVR = 'https://cdn.jsdelivr.net/npm';
export const UNPKG = 'https://unpkg.com';
export const BASE = `${V1}/dashboard/marketplace`;

export const integrityOf = (text: string) => `sha384-${createHash('sha384').update(text).digest('base64')}`;

export interface FakeVersion {
    version: string;
    status?: string;
    dashboardApi?: number;
    js?: string;
    css?: string | null;
    /** What the CDNs serve instead of the published bytes. */
    jsdelivr?: string | null;
    unpkg?: string | null;
    /** The version's settings (`config` of its record); absent: the record has none. */
    config?: unknown;
}

export interface FakePluginOptions {
    verified?: boolean;
    kind?: string;
    title?: string;
    icon?: string;
    serverPackages?: unknown;
    extensionId?: string;
    versions: FakeVersion[];
}

/** The marketplace's public API and the two CDNs, in memory. */
export class FakeNet {
    readonly plugins = new Map<string, Record<string, unknown>>();
    readonly files = new Map<string, string>();
    readonly calls: string[] = [];
    marketplaceDown = false;
    /** Answer details without `files` (an older marketplace): the version record has them. */
    filesOnlyInVersionRecord = false;
    /** Answer details without the versions' `config`: the version record has it. */
    configOnlyInVersionRecord = false;
    /** Ignore the `kind` filter (the marketplace before dashboard plugins): every plugin listed, counted and found. */
    ignoresKind = false;

    readonly fetch: MarketplaceFetch = async (url) => {
        this.calls.push(url);
        if (url.startsWith(MARKET)) {
            if (this.marketplaceDown) throw new TypeError('fetch failed');
            return this.marketplace(url);
        }
        const body = this.files.get(url);
        return body === undefined ? response(404, { error: 'not found' }) : response(200, body);
    };

    publish(name: string, options: FakePluginOptions): void {
        const versions = options.versions.map((v) => {
            const js = v.js ?? `export default { id: '${name}', version: '${v.version}' };`;
            const css = v.css === undefined ? `.x-${v.version.replace(/\W/g, '')} { color: red; }` : v.css;
            const files = [{ path: 'dist/extension.js', integrity: integrityOf(js), size: Buffer.byteLength(js) }];
            if (css !== null) files.push({ path: 'dist/extension.css', integrity: integrityOf(css), size: Buffer.byteLength(css) });
            const put = (cdn: string, path: string, published: string, served: string | null | undefined) => {
                if (served === null) return;
                this.files.set(`${cdn}/${name}@${v.version}/${path}`, served ?? published);
            };
            put(JSDELIVR, 'dist/extension.js', js, v.jsdelivr);
            put(UNPKG, 'dist/extension.js', js, v.unpkg);
            if (css !== null) {
                put(JSDELIVR, 'dist/extension.css', css, v.jsdelivr === null ? null : undefined);
                put(UNPKG, 'dist/extension.css', css, undefined);
            }
            return {
                version: v.version,
                status: v.status ?? 'listed',
                kind: options.kind ?? 'dashboard',
                files,
                dashboardApi: v.dashboardApi ?? 1,
                ...(options.serverPackages ? { serverPackages: options.serverPackages } : {}),
                ...(v.config !== undefined ? { config: v.config } : {}),
                publishedAt: '2026-11-20T10:00:00.000Z',
            };
        });
        const listed = versions.filter((v) => v.status === 'listed').map((v) => v.version).sort(compareDashboardPluginVersions);
        const latestConfig = (versions.find((v) => v.version === listed[listed.length - 1]) as { config?: unknown } | undefined)?.config;
        this.plugins.set(name, {
            name,
            shortName: name.split('/').pop(),
            description: `The ${name} page`,
            kind: options.kind ?? 'dashboard',
            ...(options.title ? { title: options.title } : {}),
            ...(options.icon ? { icon: options.icon } : {}),
            publisher: { id: name.startsWith('@') ? name.slice(1, name.indexOf('/')) : name, name: name.startsWith('@') ? name.slice(0, name.indexOf('/')) : name, verified: options.verified ?? true },
            latest: listed[listed.length - 1] ?? null,
            version: listed[listed.length - 1] ?? null,
            dashboardApi: versions.find((v) => v.version === listed[listed.length - 1])?.dashboardApi ?? 1,
            ...(options.serverPackages ? { serverPackages: options.serverPackages } : {}),
            ...(options.extensionId ? { extension: { id: options.extensionId } } : {}),
            ...(latestConfig !== undefined ? { config: latestConfig } : {}),
            versions,
        });
    }

    private marketplace(url: string) {
        const u = new URL(url);
        const path = u.pathname.slice('/api/v1/qcli/marketplace'.length);
        if (path === '/plugins') {
            const query = (u.searchParams.get('query') ?? '').toLowerCase();
            const kind = u.searchParams.get('kind');
            const items = [...this.plugins.values()]
                .filter((p) => (!kind || this.ignoresKind || p.kind === kind) && String(p.name).includes(query))
                .map(({ versions: _v, extension: _e, ...summary }) => summary);
            return response(200, { items, total: items.length, page: Number(u.searchParams.get('page') ?? 1), pageSize: Number(u.searchParams.get('pageSize') ?? 24) });
        }
        const m = /^\/plugins\/(.+?)(?:\/versions\/([^/]+))?$/.exec(path);
        if (m) {
            const plugin = this.plugins.get(decodeURIComponent(m[1]));
            // As the marketplace: a plugin of another kind (server when none is asked for) is not found
            if (!plugin || (!this.ignoresKind && plugin.kind !== (u.searchParams.get('kind') ?? 'server'))) return response(404, { error: 'plugin not found' });
            const versions = plugin.versions as Array<Record<string, unknown>>;
            if (m[2]) {
                const v = versions.find((x) => x.version === decodeURIComponent(m[2]));
                return v ? response(200, v) : response(404, { error: 'version not found' });
            }
            if (this.filesOnlyInVersionRecord) return response(200, { ...plugin, versions: versions.map(({ files: _f, ...v }) => v) });
            if (this.configOnlyInVersionRecord) return response(200, { ...plugin, versions: versions.map(({ config: _c, ...v }) => v) });
            return response(200, plugin);
        }
        return response(404, { error: 'not found' });
    }
}

export function response(status: number, body: unknown) {
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
        json: async () => JSON.parse(bytes.toString()),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

export interface Host {
    cli: CliServerResult;
    admin: CliAdminPluginResult;
    users?: UsersPluginResult;
    dir: string;
    net: FakeNet;
    audit: AuditEntry[];
    events: CliEvent[];
    token: string;
}

const hosts: Host[] = [];
const dirs: string[] = [];

/** Disposes the servers and deletes the directories of a test (`afterEach(cleanupMarketplaceHosts)`). */
export function cleanupMarketplaceHosts(): void {
    for (const h of hosts.splice(0)) {
        h.admin.dispose();
        h.cli.eventSocketManager.dispose();
        h.cli.logSocketManager.dispose();
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Keeps a server built by hand for {@link cleanupMarketplaceHosts}. */
export function trackHost(host: Host): void {
    hosts.push(host);
}

export function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'qcli-dashboard-plugins-'));
    dirs.push(dir);
    return dir;
}

/** A server with the admin plugin (password sign-in) and the fake marketplace. */
export async function start(
    options: {
        net?: FakeNet;
        dir?: string;
        install?: DashboardInstallPolicy;
        configure?: (cli: CliServerResult) => void;
        config?: CliServerConfigOptions;
        /** Default true: the command tests run the installs without sign-in (the refusal has its own tests). */
        allowAnonymousAdmin?: boolean;
    } = {},
): Promise<Host> {
    const net = options.net ?? new FakeNet();
    const dir = options.dir ?? tempDir();
    const cli = createCliServer({ allowAnonymousAdmin: options.allowAnonymousAdmin ?? true, ...(options.config ? { config: options.config } : {}) });
    const audit: AuditEntry[] = [];
    cli.builder.setConfigAuditStore({ log: async (e) => void audit.push(e), getEntries: async () => audit, clear: async () => void audit.splice(0) });
    const events: CliEvent[] = [];
    cli.eventBus.subscribe('dashboard:*', (e) => void events.push(e));
    options.configure?.(cli);
    const admin = new CliAdminBuilder()
        .setCredentials('admin', 'pass')
        .setJwtSecret('marketplace-test')
        .setMarketplace({ url: MARKET, dir, fetch: net.fetch, install: options.install })
        .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, executor: cli.executor, broadcastFn: () => {} });
    admin.logBuffer.restoreConsole();
    admin.statusSampler.stop();
    cli.mountPlugin(admin);
    const token = (await request(cli.app).post(`${V1}/auth/login`).send({ username: 'admin', password: 'pass' })).body.token as string;
    const host = { cli, admin, dir, net, audit, events, token };
    hosts.push(host);
    return host;
}

/** A protected server (users plugin) whose dashboard signs in through it; one user per entry with those permissions. */
export async function startProtected(users: Record<string, string[]>, options: { config?: CliServerConfigOptions } = {}): Promise<Host & { tokens: Record<string, string> }> {
    const net = new FakeNet();
    const dir = tempDir();
    const cli = createCliServer(options.config ? { config: options.config } : {});
    const audit: AuditEntry[] = [];
    const events: CliEvent[] = [];
    const usersPlugin = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build();
    await usersPlugin.ready;
    const admin = new CliAdminBuilder()
        .setAuthProvider(usersPlugin.serverAuth)
        .setMarketplace({ url: MARKET, dir, fetch: net.fetch })
        .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, executor: cli.executor, broadcastFn: () => {} });
    admin.logBuffer.restoreConsole();
    admin.statusSampler.stop();
    cli.mountPlugin(admin);
    cli.mountPlugin(usersPlugin);
    const login = async (username: string, password: string) => (await request(cli.app).post(`${V1}/sessions`).send({ username, password })).body.token as string;
    const tokens: Record<string, string> = { root: await login('root', ROOT_PASS) };
    for (const [name, permissions] of Object.entries(users)) {
        await request(cli.app).post(`${V1}/groups`).set('Authorization', `Bearer ${tokens.root}`).send({ name: `${name}s`, permissions }).expect(201);
        await request(cli.app)
            .post(`${V1}/users`)
            .set('Authorization', `Bearer ${tokens.root}`)
            .send({ name, email: `${name}@x.io`, password: `${name}pass`, groups: [`${name}s`] })
            .expect(201);
        tokens[name] = await login(name, `${name}pass`);
    }
    const host = { cli, admin, users: usersPlugin, dir, net, audit, events, token: tokens.root, tokens };
    hosts.push(host);
    return host;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
export const TICKETS = '@acme/cli-dashboard-tickets';
export const JOBS = '@qodalis/cli-dashboard-module-jobs';
