/**
 * Server plugins from the marketplace, without the network or npm: a fake marketplace answering the JSON of
 * cli-marketplace's `kind=server` API (list items with `platforms: { node: { package, registry, latest, install } }`
 * and, with `platform=`, `latest`/`version`/`compatible`/`reason`; details with every platform's versions in one list,
 * each with `platform`, `package`, `registry`, `serverRange`, `integrity`), a fake npm registry with real gzip'd
 * tarballs and packuments (plugins and plain dependencies), and the marketplace's dependency pins.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { createHash } from 'crypto';
import request from 'supertest';
import type { AuditEntry, CliEvent } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliAdminBuilder, CliAdminPluginResult, DashboardInstallPolicy, MarketplaceFetch } from '../../plugins/admin/index';
import { response } from './dashboard-marketplace-test-helpers';
import { ROOT_PASS, V1 } from './command-test-helpers';
import { CliUsersBuilder } from '../../plugins/users/index';

export const MARKET = 'https://market.test';
export const REGISTRY = 'https://registry.test';
export const SBASE = `${V1}/server/marketplace`;
/** The running server's version (every server package shares it). */
export const SERVER_VERSION: string = require('../../package.json').version;

/** A 200 with these bytes. */
function bytesResponse(bytes: Buffer) {
    return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
        json: async () => JSON.parse(bytes.toString()),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

export const sha512 = (bytes: Uint8Array) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** A gzip'd ustar archive of `files` (`package/...` paths), as `npm pack` makes it. */
export function makeTarball(files: Record<string, string>): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, content] of Object.entries(files)) {
        const body = Buffer.from(content);
        const header = Buffer.alloc(512);
        header.write(name, 0, 100);
        header.write('0000644\0', 100);
        header.write('0000000\0', 108);
        header.write('0000000\0', 116);
        header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
        header.write('00000000000\0', 136);
        header.write('        ', 148);
        header.write('0', 156);
        header.write('ustar\0', 257);
        header.write('00', 263);
        let sum = 0;
        for (const b of header) sum += b;
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}

/** The files of a tiny server plugin package: an entry adding a module with one command answering `text`. */
export function pluginPackage(
    name: string,
    version: string,
    options: { qodalis?: Record<string, unknown> | null; entry?: string; peer?: Record<string, string>; deps?: Record<string, string>; command?: string; text?: string } = {},
): Record<string, string> {
    const command = options.command ?? 'hello';
    const qodalis = options.qodalis === null ? undefined : { kind: 'server', entry: './plugin.js', ...(options.qodalis ?? {}) };
    return {
        'package/package.json': JSON.stringify({ name, version, description: `${name} for tests`, main: 'plugin.js', ...(qodalis ? { qodalis } : {}), ...(options.peer ? { peerDependencies: options.peer } : {}), ...(options.deps ? { dependencies: options.deps } : {}) }),
        'package/plugin.js':
            options.entry ??
            `exports.createPlugin = async (context) => ({
                name: '${command}', version: '${version}', description: 'test', author: { name: 't' },
                processors: [{ command: '${command}', description: 'says hi', handleAsync: async () => '${options.text ?? `hi from ${version}`}' }],
            });`,
    };
}

export interface FakePlatformVersion {
    version: string;
    status?: string;
    serverRange?: string | null;
    /** What the npm registry serves for the version (default `pluginPackage`). */
    files?: Record<string, string>;
    /** Served instead of the published tarball. */
    tampered?: boolean;
    /** The marketplace's integrity instead of the registry's. */
    marketplaceIntegrity?: string;
    /** The npm record's `qodalis` block (default: the package.json's). */
    npmQodalis?: Record<string, unknown>;
    /** The marketplace's dependency pins for the version (absent: none). */
    dependencies?: Array<{ id: string; version: string; integrity: string; range?: string }>;
}

export interface FakeServerPlugin {
    verified?: boolean;
    title?: string;
    icon?: string;
    /** The Node package (default `@qodalis/cli-server-plugin-<name>`); null: no Node package. */
    node?: string | null;
    /** Other platforms' packages: `{ python: 'qodalis-cli-server-plugin-x' }`. */
    others?: Record<string, string>;
    versions: FakePlatformVersion[];
}

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** The marketplace's API, the npm registry and its tarballs, in memory. */
export class FakeServerNet {
    readonly plugins = new Map<string, Record<string, unknown>>();
    /** npm: `<package>@<version>` -> its record and tarball. */
    readonly npm = new Map<string, { record: Record<string, unknown>; tarball: Buffer; served: Buffer }>();
    readonly calls: string[] = [];
    readonly distTags = new Map<string, Record<string, string>>();
    marketplaceDown = false;
    /** As the marketplace before `platform` filtered the list: every server plugin, whatever `platform` says. */
    ignorePlatformFilter = false;

    /**
     * A plain npm package (a dependency): its record, packument entry and tarball; `tampered` serves other bytes.
     * Returns its sha512, for a pin.
     */
    publishPackage(name: string, version: string, options: { deps?: Record<string, string>; tampered?: boolean; latest?: boolean } = {}): string {
        const files = {
            'package/package.json': JSON.stringify({ name, version, main: 'index.js', ...(options.deps ? { dependencies: options.deps } : {}) }),
            'package/index.js': `module.exports = { name: '${name}', version: '${version}' };`,
        };
        const tarball = makeTarball(files);
        const integrity = sha512(tarball);
        this.npm.set(`${name}@${version}`, {
            record: { ...JSON.parse(files['package/package.json']), dist: { tarball: `${REGISTRY}/-/tarballs/${encodeURIComponent(`${name}@${version}`)}`, integrity } },
            tarball,
            served: options.tampered ? makeTarball({ ...files, 'package/evil.js': 'boom' }) : tarball,
        });
        if (options.latest) this.distTags.set(name, { latest: version });
        return integrity;
    }

    readonly fetch: MarketplaceFetch = async (url) => {
        this.calls.push(url);
        if (url.startsWith(MARKET)) {
            if (this.marketplaceDown) throw new TypeError('fetch failed');
            return this.marketplace(url);
        }
        if (url.startsWith(`${REGISTRY}/-/tarballs/`)) {
            const key = decodeURIComponent(url.slice(`${REGISTRY}/-/tarballs/`.length));
            const entry = this.npm.get(key);
            return entry ? bytesResponse(entry.served) : response(404, { error: 'not found' });
        }
        if (url.startsWith(REGISTRY)) {
            const doc = /^\/([^/]+)$/.exec(url.slice(REGISTRY.length));
            if (doc) {
                const name = decodeURIComponent(doc[1]);
                const versions = [...this.npm.entries()].filter(([key]) => key.slice(0, key.lastIndexOf('@')) === name);
                if (!versions.length) return response(404, { error: 'not found' });
                const tags = this.distTags.get(name);
                return response(200, { name, ...(tags ? { 'dist-tags': tags } : {}), versions: Object.fromEntries(versions.map(([key, e]) => [key.slice(key.lastIndexOf('@') + 1), e.record])) });
            }
            const m = /^\/(.+)\/([^/]+)$/.exec(url.slice(REGISTRY.length));
            const entry = m ? this.npm.get(`${decodeURIComponent(m[1])}@${decodeURIComponent(m[2])}`) : undefined;
            return entry ? response(200, entry.record) : response(404, { error: 'not found' });
        }
        return response(404, { error: 'not found' });
    };

    publish(name: string, options: FakeServerPlugin): void {
        const pkg = options.node === undefined ? `@qodalis/cli-server-plugin-${name}` : options.node;
        const versions: Array<Record<string, unknown>> = [];
        if (pkg) {
            for (const v of options.versions) {
                const files = v.files ?? pluginPackage(pkg, v.version);
                const tarball = makeTarball(files);
                const served = v.tampered ? makeTarball({ ...files, 'package/evil.js': 'boom' }) : tarball;
                const manifest = JSON.parse(files['package/package.json']) as Record<string, unknown>;
                const integrity = sha512(tarball);
                this.npm.set(`${pkg}@${v.version}`, {
                    record: {
                        ...manifest,
                        ...(v.npmQodalis ? { qodalis: v.npmQodalis } : {}),
                        dist: { tarball: `${REGISTRY}/-/tarballs/${encodeURIComponent(`${pkg}@${v.version}`)}`, integrity },
                    },
                    tarball,
                    served,
                });
                versions.push({
                    version: v.version,
                    kind: 'server',
                    platform: 'node',
                    package: pkg,
                    registry: 'npm',
                    apiVersion: 0,
                    coreRange: null,
                    bundle: '',
                    integrity: v.marketplaceIntegrity ?? integrity,
                    size: tarball.length,
                    serverRange: v.serverRange === undefined ? '^1.0.0-beta.3' : v.serverRange,
                    publishedAt: '2026-11-23T10:00:00Z',
                    status: v.status ?? 'listed',
                    ...(v.dependencies ? { dependencies: v.dependencies } : {}),
                });
            }
        }
        for (const [platform, other] of Object.entries(options.others ?? {})) {
            versions.push({ version: '1.0.0b31', kind: 'server', platform, package: other, registry: platform === 'python' ? 'pypi' : 'nuget', integrity: 'sha256-y', serverRange: '>=1.0.0b30', status: 'listed' });
        }
        const listedNode = versions.filter((v) => v.platform === 'node' && v.status === 'listed').map((v) => String(v.version)).sort(cmp);
        const platforms: Record<string, unknown> = {};
        if (pkg) platforms.node = { package: pkg, registry: 'npm', latest: listedNode[listedNode.length - 1] ?? null, install: `npm install ${pkg}` };
        for (const [platform, other] of Object.entries(options.others ?? {})) {
            platforms[platform] = { package: other, registry: platform === 'python' ? 'pypi' : 'nuget', latest: '1.0.0b31', install: `pip install ${other}` };
        }
        this.plugins.set(name, {
            name,
            shortName: name,
            kind: 'server',
            title: options.title ?? name[0].toUpperCase() + name.slice(1),
            ...(options.icon ? { icon: options.icon } : {}),
            category: 'server',
            description: `The ${name} plugin`,
            publisher: { id: '@qodalis', name: 'qodalis', verified: options.verified ?? true },
            platforms,
            versions,
        });
    }

    private marketplace(url: string) {
        const u = new URL(url);
        const path = u.pathname.slice('/api/v1/qcli/marketplace'.length);
        const platform = u.searchParams.get('platform');
        const serverVersion = u.searchParams.get('serverVersion');
        // The marketplace's own view of a platform: its newest listed version that fits serverVersion
        const view = (plugin: Record<string, unknown>) => {
            if (!platform) return {};
            const platforms = plugin.platforms as Record<string, unknown>;
            if (!platforms[platform]) return { latest: null, version: null, compatible: false, reason: `not available for ${platform}` };
            const listed = (plugin.versions as Array<Record<string, unknown>>)
                .filter((v) => v.platform === platform && v.status === 'listed')
                .sort((a, b) => cmp(String(b.version), String(a.version)));
            const fits = (v: Record<string, unknown>) => {
                if (!serverVersion || !v.serverRange) return true;
                const m = /^(?:\^|>=)(.+)$/.exec(String(v.serverRange));
                return !m || cmp(serverVersion, m[1]) >= 0;
            };
            const fitting = listed.find(fits);
            if (fitting) return { latest: fitting.version, version: fitting.version, compatible: true };
            return { latest: null, version: null, compatible: false, reason: `needs server ${listed[0]?.serverRange} (this server has ${serverVersion})` };
        };
        if (path === '/plugins') {
            if (u.searchParams.get('kind') !== 'server') return response(200, { items: [], total: 0, page: 1, pageSize: 24 });
            const query = (u.searchParams.get('query') ?? '').toLowerCase();
            const items = [...this.plugins.values()]
                .filter((p) => String(p.name).includes(query) && (!platform || this.ignorePlatformFilter || (p.platforms as Record<string, unknown>)[platform]))
                .map(({ versions: _v, ...summary }) => ({ ...summary, ...view(_v ? { ...summary, versions: _v } : summary) }));
            return response(200, { items, total: items.length, page: 1, pageSize: Number(u.searchParams.get('pageSize') ?? 24) });
        }
        const m = /^\/plugins\/([^/]+)(?:\/versions\/([^/]+))?$/.exec(path);
        if (m) {
            const plugin = this.plugins.get(decodeURIComponent(m[1]));
            // As the marketplace: a plugin of another kind (server when none is asked for) is not found
            if (!plugin || (plugin.kind ?? 'server') !== (u.searchParams.get('kind') ?? 'server')) return response(404, { error: 'plugin not found' });
            if (m[2]) {
                const [p, v] = decodeURIComponent(m[2]).split(':');
                const found = (plugin.versions as Array<Record<string, unknown>>).find((x) => x.platform === p && x.version === v);
                return found ? response(200, found) : response(404, { error: 'version not found' });
            }
            return response(200, { ...plugin, ...view(plugin) });
        }
        return response(404, { error: 'not found' });
    }
}

export interface ServerHost {
    cli: CliServerResult;
    admin: CliAdminPluginResult;
    dataDir: string;
    net: FakeServerNet;
    audit: AuditEntry[];
    events: CliEvent[];
    token: string;
    tokens: Record<string, string>;
}

const hosts: ServerHost[] = [];
const dirs: string[] = [];

export function serverTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'qcli-server-plugins-'));
    dirs.push(dir);
    return dir;
}

export function cleanupServerHosts(): void {
    for (const h of hosts.splice(0)) {
        h.admin.dispose();
        h.cli.eventSocketManager.dispose();
        h.cli.logSocketManager.dispose();
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/**
 * A server with the admin plugin pointed at the fakes (password sign-in, or a protected server through the users
 * plugin with one user per `users` entry); its runtime plugins loaded before it answers.
 */
export async function startServer(
    options: {
        net?: FakeServerNet;
        dataDir?: string;
        /** The packages the host resolves and their versions, null for none (default: `@qodalis/*` at the server's version only). */
        hostPackages?: Record<string, string | null>;
        trustedDependencies?: string[];         install?: DashboardInstallPolicy;
        users?: Record<string, string[]>;
        configure?: (cli: CliServerResult) => void;
        serverPlugins?: false;
        /** Default true: the command tests run the installs without sign-in (the refusal has its own tests). */
        allowAnonymousAdmin?: boolean;
    } = {},
): Promise<ServerHost> {
    const net = options.net ?? new FakeServerNet();
    const dataDir = options.dataDir ?? serverTempDir();
    const cli = createCliServer({ dataDir, allowAnonymousAdmin: options.allowAnonymousAdmin ?? true, ...(options.serverPlugins === false ? { serverPlugins: false as const } : {}) });
    const audit: AuditEntry[] = [];
    cli.builder.setConfigAuditStore({ log: async (e) => void audit.push(e), getEntries: async () => audit, clear: async () => void audit.splice(0) });
    const events: CliEvent[] = [];
    cli.eventBus.subscribe('server:*', (e) => void events.push(e));
    options.configure?.(cli);
    const hostPackages = options.hostPackages ?? {};
    const marketplace = {
        url: MARKET,
        dir: join(dataDir, 'dashboard-plugins'),
        fetch: net.fetch,
        npmRegistry: REGISTRY,
        install: options.install,
        trustedDependencies: options.trustedDependencies,
        hostPackageVersion: (name: string) => (name in hostPackages ? (hostPackages[name] ?? undefined) : name.startsWith('@qodalis/') ? SERVER_VERSION : undefined),
    };
    const tokens: Record<string, string> = {};
    let admin: CliAdminPluginResult;
    if (options.users) {
        const usersPlugin = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build();
        await usersPlugin.ready;
        admin = new CliAdminBuilder()
            .setAuthProvider(usersPlugin.serverAuth)
            .setMarketplace(marketplace)
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, executor: cli.executor, broadcastFn: () => {} });
        cli.mountPlugin(admin);
        cli.mountPlugin(usersPlugin);
        const login = async (username: string, password: string) => (await request(cli.app).post(`${V1}/sessions`).send({ username, password })).body.token as string;
        tokens.root = await login('root', ROOT_PASS);
        for (const [name, permissions] of Object.entries(options.users)) {
            await request(cli.app).post(`${V1}/groups`).set('Authorization', `Bearer ${tokens.root}`).send({ name: `${name}s`, permissions }).expect(201);
            await request(cli.app).post(`${V1}/users`).set('Authorization', `Bearer ${tokens.root}`).send({ name, email: `${name}@x.io`, password: `${name}pass`, groups: [`${name}s`] }).expect(201);
            tokens[name] = await login(name, `${name}pass`);
        }
    } else {
        admin = new CliAdminBuilder()
            .setCredentials('admin', 'pass')
            .setJwtSecret('server-marketplace-test')
            .setMarketplace(marketplace)
            .build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, executor: cli.executor, broadcastFn: () => {} });
        cli.mountPlugin(admin);
        tokens.root = (await request(cli.app).post(`${V1}/auth/login`).send({ username: 'admin', password: 'pass' })).body.token as string;
    }
    admin.logBuffer.restoreConsole();
    admin.statusSampler.stop();
    await cli.serverPlugins.ready();
    const host = { cli, admin, dataDir, net, audit, events, token: tokens.root, tokens };
    hosts.push(host);
    return host;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
