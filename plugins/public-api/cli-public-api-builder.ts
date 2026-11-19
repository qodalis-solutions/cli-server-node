import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { CliInstalledPlugin } from '@qodalis/cli-server-abstractions';
import { IPublicApiUsageStore, InMemoryPublicApiUsageStore } from './usage-store';
import {
    PublicApiQuotaResolver,
    QcliCaller,
    UNLIMITED,
    dayBefore,
    dayWindow,
    minuteWindow,
    normalizeLimit,
    rateLimitHeaders,
    secondsToNextDay,
    secondsToNextMinute,
} from './quota';
import { ApiTokenUsage, PublicApiAccountUsage, PublicApiUsageService } from './usage-service';
import { publicApiInstalledPlugin } from './package-info';
import { documentTitle, loadOpenApiSource, publicDocument } from './openapi';
import { swaggerAssets, swaggerPage, swaggerUiDir } from './swagger';

export const DEFAULT_PUBLIC_API_BASE_PATH = '/qcli/api';
export const DEFAULT_PUBLIC_API_TITLE = 'API reference';
export const DEFAULT_USAGE_RETENTION_DAYS = 31;
/** The answer to a session, an adapter sign-in or a `cli` token (the users plugin's text). */
export const HOST_TOKEN_REQUIRED = 'forbidden: a host token is required';
export const NO_API_ACCESS = 'forbidden: no API access';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Set on a request once a guard counted it: the token and the windows it was counted in. */
const COUNTED: unique symbol = Symbol('qcli.publicApi.counted');
const RATE_LIMIT_HEADERS = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'];

/**
 * The users plugin's take-back slot (`Symbol.for`, no import): set once a request is counted,
 * run by any later guard (users or public-api) that refuses it.
 */
const ON_REFUSED: unique symbol = Symbol.for('qcli.onRefused') as never;

type CountedRequest = Request & {
    qcliCaller?: QcliCaller;
    [COUNTED]?: { tokenId: string; windows: string[] };
    [ON_REFUSED]?: () => Promise<void>;
};

const MINUTE_ROWS_KEPT = 2;
export const INVALID_PATH_BASE = 'invalid path base';

/**
 * The path the app is mounted under (a parent app's `app.use('/prefix', cli.app)`): the
 * request's `baseUrl` before the plugin's own `prefix`; undefined when it starts with `//`
 * or `/\` (it would point URLs at another host).
 */
export function mountPathBase(req: Request, prefix: string): string | undefined {
    const base = prefix === '/' ? req.baseUrl : req.baseUrl.slice(0, Math.max(0, req.baseUrl.length - prefix.length));
    // `//`, `/\`, whitespace or control characters (`/\t/host` reads as `//host` in a browser)
    return base.startsWith('//') || base.startsWith('/\\') || /[\s\u0000-\u001f\u007f]/.test(base) ? undefined : base;
}

/**
 * The users-plugin members this plugin reads (`setUsers(usersPlugin)`); structurally
 * the users plugin's result, which this package does not depend on.
 */
export interface PublicApiUsers {
    /** Authentication, host tokens only, then the permissions (the users plugin's texts). */
    requireHostToken(...permissions: string[]): RequestHandler;
    setTokenUsageProvider(provider: ((tokenIds: string[]) => Promise<Record<string, ApiTokenUsage>>) | null): void;
    apiTokens: { list(userId: string): Promise<Array<{ id: string; name: string; usage?: ApiTokenUsage }>> };
    getUser(id: string): Promise<{ id: string; name: string } | undefined>;
    /** The users plugin's permission matching (wildcards), for stacked guards. */
    serverAuth: { hasPermission(ctx: { permissions: string[] }, permission: string): boolean };
    authService?: { getEffectivePermissions(user: { id: string; name: string }): Promise<string[]> };
}

/** Where the portal finds this plugin's section (`new CliPortalBuilder().addSection(publicApi)`). */
export interface PublicApiPortalSection {
    kind: 'api';
    title: string;
    basePath: string;
}

export interface PublicApiPluginResult {
    /** The base path (default `/qcli/api`): the public OpenAPI document and Swagger UI. */
    prefix: string;
    router: Router;
    /** Host routes: its prefix is not a CLI route (host tokens reach it). */
    cliRoutes: false;
    /** The document and Swagger UI stay public on a protected server (`mountPlugin` reads them). */
    publicRoutes: string[];
    /**
     * The guard for a public route: a `host` token holding `permission` (when given), within
     * the account's quota. Sets `req.qcliCaller` and the `X-RateLimit-*` headers.
     *
     * @example app.get('/v1/rates', publicApi.guard('rates:read'), handler)
     */
    guard(permission?: string): RequestHandler[];
    /** Usage for a host's own pages. */
    usage: { account(userId: string): Promise<PublicApiAccountUsage> };
    /** The usage counters. */
    store: IPublicApiUsageStore;
    /** Read by the portal plugin. */
    portalSection: PublicApiPortalSection;
    installedPlugin: CliInstalledPlugin;
}

/** True for `/segment[/segment...]`: starts with `/`, no trailing `/`, not `/` itself. */
export function isValidBasePath(path: unknown): path is string {
    return typeof path === 'string' && /^(\/[A-Za-z0-9._~-]+)+$/.test(path);
}

/**
 * Fluent builder for the public-api plugin: a guard for the host's public routes (host
 * tokens only, per-account daily and per-minute quotas, usage counted per token and day),
 * the usage on the users plugin's token views, and (Swagger UI and the OpenAPI document)
 * the host's public API description.
 *
 * @example
 * ```ts
 * const publicApi = new CliPublicApiBuilder()
 *     .setUsers(usersPlugin)
 *     .setQuota((caller) => ({ requestsPerDay: 1000, requestsPerMinute: 60 }))
 *     .build();
 * mountPlugin(publicApi);
 * app.get('/v1/rates', publicApi.guard('rates:read'), (req, res) => res.json(rates));
 * ```
 */
export class CliPublicApiBuilder {
    private users?: PublicApiUsers;
    private basePath = DEFAULT_PUBLIC_API_BASE_PATH;
    private title = DEFAULT_PUBLIC_API_TITLE;
    private serverUrl?: string;
    private openApi?: object | string;
    private quota?: PublicApiQuotaResolver;
    private store?: IPublicApiUsageStore;
    private retentionDays = DEFAULT_USAGE_RETENTION_DAYS;
    private clock: () => Date = () => new Date();

    /** The users plugin (required): its guards authenticate, its token views show the usage. */
    setUsers(users: PublicApiUsers): this {
        this.users = users;
        return this;
    }

    /** Where the document and Swagger UI are served (default `/qcli/api`). */
    setBasePath(path: string): this {
        this.basePath = path;
        return this;
    }

    /** The portal's label for the API section (default `API reference`). */
    setTitle(title: string): this {
        this.title = title;
        return this;
    }

    /**
     * The public API's OpenAPI document: an object (served as given, with the additions), or
     * a path to a JSON file (relative to the working directory) read once by `build()`.
     */
    setOpenApi(source: object | string): this {
        this.openApi = source;
        return this;
    }

    /** The document's `servers` URL when it has none (default: the request's `scheme://host`). */
    setServerUrl(url: string): this {
        if (!/^https?:\/\/[^\s]+$/.test(url)) {
            throw new Error(`public-api: the server URL must be an http(s) URL: ${url}`);
        }
        this.serverUrl = url.replace(/\/+$/, '');
        return this;
    }

    /**
     * The caller's limits, per account (sync or async; none = unlimited). A throw or a
     * rejection answers 500 `internal server error` and the request is not counted.
     */
    setQuota(resolver: PublicApiQuotaResolver): this {
        this.quota = resolver;
        return this;
    }

    /** The usage counters (default in memory, one process). A shared store shares the limits. */
    setUsageStore(store: IPublicApiUsageStore): this {
        this.store = store;
        return this;
    }

    /** Days the day counters are kept (default 31); minute counters are kept 2 minutes. */
    setUsageRetentionDays(days: number): this {
        if (!Number.isInteger(days) || days < 1) {
            throw new Error(`public-api: usage retention must be a positive number of days: ${days}`);
        }
        this.retentionDays = days;
        return this;
    }

    /** The clock the windows are read from (tests). */
    setClock(now: () => Date): this {
        this.clock = now;
        return this;
    }

    build(): PublicApiPluginResult {
        const users = this.users;
        if (!users) {
            throw new Error('public-api: setUsers(usersPlugin) is required');
        }
        if (!isValidBasePath(this.basePath)) {
            throw new Error(`invalid public-api base path: ${this.basePath}`);
        }
        const basePath = this.basePath;
        const document = loadOpenApiSource(this.openApi);
        const serverUrl = this.serverUrl;
        const store = this.store ?? new InMemoryPublicApiUsageStore();
        const now = this.clock;
        const retentionDays = this.retentionDays;
        const getQuota = () => this.quota;
        const usage = new PublicApiUsageService(store, users, getQuota, now);
        users.setTokenUsageProvider((ids) => usage.tokenUsage(ids));

        let lastPrune = 0;
        const pruneNow = (at: Date) => {
            if (at.getTime() - lastPrune < PRUNE_INTERVAL_MS) return;
            lastPrune = at.getTime();
            const beforeMinute = minuteWindow(new Date(at.getTime() - MINUTE_ROWS_KEPT * 60_000));
            store.prune(dayBefore(at, retentionDays), beforeMinute).catch((err) => {
                console.error('[public-api] usage prune failed:', err);
            });
        };

        // Admissions of one account run one at a time in this process, so its limit admits
        // exactly that many requests; the store's increment-then-check keeps processes that
        // share it from admitting more than the limit.
        const accountQueues = new Map<string, Promise<void>>();
        const serialized = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
            const previous = accountQueues.get(userId) ?? Promise.resolve();
            let release!: () => void;
            const current = new Promise<void>((r) => (release = r));
            const tail = previous.then(() => current);
            accountQueues.set(userId, tail);
            await previous;
            try {
                return await fn();
            } finally {
                release();
                if (accountQueues.get(userId) === tail) accountQueues.delete(userId);
            }
        };

        // A refused request carries no caller: only an admitted one reaches code with `req.qcliCaller`
        const forgetCaller = (req: Request) => {
            const r = req as Request & { qcliCaller?: unknown; qcliAuth?: unknown };
            delete r.qcliCaller;
            delete r.qcliAuth;
        };
        const internalError = (req: Request, res: Response, what: string, err: unknown) => {
            forgetCaller(req);
            // never expose the error's text
            console.error(`[public-api] ${what}:`, err);
            if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
        };

        const admit: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
            const caller = (req as Request & { qcliCaller?: QcliCaller }).qcliCaller;
            if (!caller || caller.audience !== 'host' || !caller.tokenId) {
                forgetCaller(req);
                res.status(403).json({ error: HOST_TOKEN_REQUIRED });
                return;
            }
            const tokenId = caller.tokenId;
            const marked = req as CountedRequest;
            if (marked[COUNTED]) {
                // a stacked guard: counted once, by the first guard
                next();
                return;
            }
            (async () => {
                let perDay: number | null;
                let perMinute: number | null;
                try {
                    const resolver = getQuota();
                    const quota = resolver ? await resolver({ ...caller, permissions: [...caller.permissions] }) : UNLIMITED;
                    perDay = normalizeLimit(quota?.requestsPerDay);
                    perMinute = normalizeLimit(quota?.requestsPerMinute);
                } catch (err) {
                    internalError(req, res, 'quota resolver failed', err);
                    return;
                }
                if (perDay === 0 || perMinute === 0) {
                    forgetCaller(req);
                    res.status(403).json({ error: NO_API_ACCESS });
                    return;
                }
                const at = now();
                const day = dayWindow(at);
                const minute = minuteWindow(at);
                let outcome: { refused?: 'day' | 'minute'; cancelled?: boolean; dayCount: number; minuteCount: number };
                try {
                    outcome = await serialized(caller.userId, async () => {
                        // increment, check the account's sums, compensate when over a limit
                        // the client went away while waiting: not counted, nothing answered
                        if (req.socket?.destroyed || res.destroyed) {
                            return { cancelled: true, dayCount: 0, minuteCount: 0 };
                        }
                        const counted: string[] = [];
                        try {
                            await store.increment(tokenId, caller.userId, day);
                            counted.push(day);
                            await store.increment(tokenId, caller.userId, minute);
                            counted.push(minute);
                            const dayCount = await store.accountCount(caller.userId, day);
                            const minuteCount = await store.accountCount(caller.userId, minute);
                            const refused =
                                perDay !== null && dayCount > perDay
                                    ? 'day'
                                    : perMinute !== null && minuteCount > perMinute
                                      ? 'minute'
                                      : undefined;
                            if (refused) {
                                await store.decrement(tokenId, day);
                                counted.shift();
                                await store.decrement(tokenId, minute);
                                counted.shift();
                            }
                            return { refused, dayCount, minuteCount } as const;
                        } catch (err) {
                            // a request answered 500 is not left counted (best effort)
                            for (const window of counted) {
                                await store.decrement(tokenId, window).catch(() => undefined);
                            }
                            throw err;
                        }
                    });
                } catch (err) {
                    internalError(req, res, 'usage store failed', err);
                    return;
                }
                if (outcome.cancelled) {
                    res.destroy();
                    return;
                }
                if (!outcome.refused) {
                    marked[COUNTED] = { tokenId, windows: [day, minute] };
                    // a later guard refusing the request takes the count (and the headers) back
                    marked[ON_REFUSED] = async () => {
                        delete marked[ON_REFUSED];
                        delete marked[COUNTED];
                        for (const header of RATE_LIMIT_HEADERS) res.removeHeader(header);
                        try {
                            await Promise.all([day, minute].map((w) => store.decrement(tokenId, w)));
                        } catch (err) {
                            console.error('[public-api] usage store failed:', err);
                        }
                    };
                }
                pruneNow(at);
                const headers = rateLimitHeaders({ perDay, perMinute }, outcome.dayCount, outcome.minuteCount, at);
                if (headers) {
                    res.setHeader('X-RateLimit-Limit', String(headers.limit));
                    res.setHeader('X-RateLimit-Remaining', String(outcome.refused ? 0 : headers.remaining));
                    res.setHeader('X-RateLimit-Reset', String(headers.reset));
                }
                if (outcome.refused === 'day') {
                    res.setHeader('Retry-After', String(secondsToNextDay(at)));
                    forgetCaller(req);
                    res.status(429).json({ error: `quota exceeded: ${perDay} requests per day` });
                    return;
                }
                if (outcome.refused === 'minute') {
                    res.setHeader('Retry-After', String(secondsToNextMinute(at)));
                    forgetCaller(req);
                    res.status(429).json({ error: `too many requests: ${perMinute} per minute` });
                    return;
                }
                next();
            })().catch((err) => internalError(req, res, 'guard failed', err));
        };

        const guard = (permission?: string): RequestHandler[] => {
            // authentication, then host tokens only, then the permission (the users plugin's texts)
            const authenticate = users.requireHostToken(...(permission ? [permission] : []));
            const check: RequestHandler = (req, res, next) => {
                const marked = req as CountedRequest;
                const counted = marked[COUNTED];
                if (!counted) {
                    authenticate(req, res, next);
                    return;
                }
                // A later stacked guard checks only its own permission. Express runs the guards one
                // after the other, so the first one cannot see this permission: a refusal here takes
                // the request's count back, so a refused request is not counted.
                if (!permission || users.serverAuth.hasPermission({ permissions: marked.qcliCaller?.permissions ?? [] }, permission)) {
                    next();
                    return;
                }
                const takeBack = marked[ON_REFUSED] ?? (async () => undefined);
                takeBack().finally(() => {
                    forgetCaller(req);
                    res.status(403).json({ error: `forbidden: missing permission ${permission}` });
                });
            };
            return [check, admit];
        };

        // The document and Swagger UI: no sign-in, credentials ignored
        const router = Router();
        router.get('/openapi.json', (req, res) => {
            const pathBase = mountPathBase(req, basePath);
            if (pathBase === undefined) {
                res.setHeader('Cache-Control', 'no-cache').status(400).json({ error: INVALID_PATH_BASE });
                return;
            }
            const url = serverUrl ?? `${req.protocol}://${req.get('host') ?? 'localhost'}${pathBase}`;
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.json(publicDocument(document(), url));
        });
        router.get('/swagger', (req, res) => {
            const pathBase = mountPathBase(req, basePath);
            if (pathBase === undefined) {
                res.setHeader('Cache-Control', 'no-cache').status(400).json({ error: INVALID_PATH_BASE });
                return;
            }
            res.setHeader('Cache-Control', 'no-cache');
            res.type('html').send(swaggerPage(pathBase + basePath, documentTitle(document())));
        });
        router.get('/swagger/assets/:file', swaggerAssets(swaggerUiDir()));
        // every other path under the public `/swagger/*` prefix is this plugin's 404, never a host route
        router.get('/swagger/*', (_req, res) => {
            res.setHeader('Cache-Control', 'no-cache').status(404).json({ error: 'not found' });
        });
        // public on a protected server, under /api too (the gate never opens a CLI route this way)
        const publicRoutes = [
            ...['/openapi.json', '/swagger'].flatMap((p) => [`GET ${basePath}${p}`, `HEAD ${basePath}${p}`]),
            `GET ${basePath}/swagger/*`,
        ];

        return {
            prefix: basePath,
            router,
            cliRoutes: false,
            publicRoutes,
            guard,
            usage: { account: (userId: string) => usage.account(userId) },
            store,
            portalSection: { kind: 'api', title: this.title, basePath },
            installedPlugin: publicApiInstalledPlugin,
        };
    }
}
