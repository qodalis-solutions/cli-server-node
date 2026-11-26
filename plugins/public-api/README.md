# @qodalis/cli-server-plugin-public-api

Public API plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node): publish your own REST routes as a public API. A guard admits only `host` API tokens of the [users plugin](../users/README.md), checks the route's permission and the account's daily and per-minute quotas, counts each request per token and day, and shows that usage on the token views. Implements the same contract as the .NET (`Qodalis.Cli.Plugin.PublicApi`) and Python servers.

## Install

```bash
npm install @qodalis/cli-server-plugin-public-api
```

## Usage

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';
import { CliPublicApiBuilder } from '@qodalis/cli-server-plugin-public-api';

const cli = createCliServer();
cli.builder.addPermissions([{ name: 'rates:read', description: 'Exchange rates', group: 'Rates' }]);

const users = new CliUsersBuilder().build();
cli.mountPlugin(users);

const publicApi = new CliPublicApiBuilder()
    .setUsers(users)
    .setQuota(async (caller) => (await plans.of(caller.userId)).quota) // { requestsPerDay, requestsPerMinute }
    .build();
cli.mountPlugin(publicApi);

cli.app.get('/v1/rates', publicApi.guard('rates:read'), (req, res) => {
    res.json({ rates: [], account: req.qcliCaller!.userId });
});
```

Your users get `host` tokens from your own pages through `users.apiTokens.create(userId, { name, audience: 'host', permissions: ['rates:read'] })`; those tokens are refused on every CLI route.

## The guard

`publicApi.guard(permission?)` returns the middlewares to put before a route's handler. The first failing check answers and the request is not counted:

| # | Condition | Answer |
|---|---|---|
| 1 | authentication fails | as the users plugin's guards: 401 `unauthorized` (no credentials), 401 `invalid or expired token` (unknown, expired or revoked token, or a disabled user's token or session), 401 `session expired`, 401 `account disabled` (a disabled user signed in by an auth adapter), 403 `password change required` |
| 2 | not a `host` token (a session, an auth-adapter sign-in, a `cli` token) | 403 `forbidden: a host token is required` |
| 3 | the permission is given and not held | 403 `forbidden: missing permission <permission>` |
| 4 | the quota resolver throws or rejects | 500 `internal server error` (the error is logged, its text never sent) |
| 5 | a limit is `0` (or negative) | 403 `forbidden: no API access` |
| 6 | the account's requests today reached `requestsPerDay` | 429 `quota exceeded: <n> requests per day`, `Retry-After` = seconds to the next UTC midnight |
| 7 | the account's requests this minute reached `requestsPerMinute` | 429 `too many requests: <n> per minute`, `Retry-After` = seconds to the next UTC minute |

Otherwise the request is counted and the handler runs, with `req.qcliCaller` (`{ userId, userName, tokenId, audience, permissions }`).

**Quotas are per account:** each token has its own counters (for display), and the limits apply to the sum over every token of the user, revoked tokens included, so more tokens never mean more requests and revoking a token does not reset the day. Windows are fixed UTC days (`yyyy-MM-dd`) and minutes, whatever the server's time zone. The resolver gets the caller; without one, requests are unlimited (and still counted).

Every answer that passed check 3 (429s and the handler's own answers included) carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds until the window resets, at least 1). They describe the daily limit when it is set, otherwise the per-minute one, and are left out when both are unlimited.

## OpenAPI document and Swagger UI

Hand over the document of your public routes (an object, or a path to a JSON file read once by `build()`):

```typescript
const publicApi = new CliPublicApiBuilder()
    .setUsers(users)
    .setOpenApi('./openapi/public.json') // or an object
    .setServerUrl('https://api.example.com') // optional
    .build();
```

| Route | Answer |
|---|---|
| `GET /qcli/api/openapi.json` | The document, `Cache-Control: no-cache`, `Access-Control-Allow-Origin: *`; no sign-in, credentials ignored |
| `GET /qcli/api/swagger` | Swagger UI 5 for that document only (`persistAuthorization: false`, "try it out" on), titled with `info.title` |
| `GET /qcli/api/swagger/assets/<file>` | Swagger UI's own files (`swagger-ui-dist`) |

What the document lacks is added, and the host's own values always win: the bearer scheme `components.securitySchemes.qcliToken` (`{ type: 'http', scheme: 'bearer', bearerFormat: 'qcli_pat' }`), a top-level `security: [{ qcliToken: [] }]`, and `servers: [{ url }]` with `setServerUrl`, else the request's `scheme://host` plus the path the app is mounted under (a parent app's `app.use('/prefix', cli.app)`; a path base starting with `//` or `/\`, or holding whitespace or control characters, answers 400 `{ "error": "invalid path base" }`). Express has no route metadata, so state each operation's permission in your document as `x-required-permission: "rates:read"` (the portal shows it); your `x-codeSamples` are passed through. Without `setOpenApi` an empty document (`info.title` `API`) is served. On a protected server these routes stay public, under `/api` too.

The portal plugin shows the document as an API reference with code samples (`new CliPortalBuilder().addSection(publicApi)`).

## Usage

With the plugin built, `GET /api/v1/qcli/tokens` and `users.apiTokens.list(userId)` add `usage` to every token view (`{ today, last30Days, days: [{ date, requests }] }`, 30 UTC days, oldest first). For your own account pages:

```typescript
const usage = await publicApi.usage.account(userId);
// { today, quota: { requestsPerDay, requestsPerMinute }, tokens: [{ tokenId, name, usage }] }
```

An unknown user rejects with a `PublicApiError` (`status` 404, `user not found`).

## Terminal commands

`api`, registered by `mountPlugin`. The guard's routes are the host's (`app.get(path, publicApi.guard(...))`), so the
plugin does not know them and there is no `api routes`.

| Command | Permission | Does |
|---|---|---|
| `api`, `api usage [--days 7] [--json]` | none beyond `commands:execute` | Your requests per token and UTC day (1-30 days, today included), totals, today's requests of every token (revoked ones too) and your quota |
| `api usage --user <name\|id>` | `tokens:read` for another account (like `GET /tokens?all=true`) | The same for another account |

```text
$ api usage --user alice --days 3
alice: 13 request(s) today (every token, revoked ones too)
Quota: 1000 per day, 60 per minute
Day         website  ci-bot  Total
2026-11-23        0       0      0
2026-11-24        2       0      2
2026-11-25        3      10     13
Total             5      10     15
```

## Builder

| Method | Default | Description |
|---|---|---|
| `setUsers(usersPlugin)` | required | The users plugin: its guards authenticate, its token views show the usage |
| `setQuota(resolver)` | unlimited | `(caller) => PublicApiQuota \| Promise<PublicApiQuota>`; `null` limits are unlimited |
| `setUsageStore(store)` | `InMemoryPublicApiUsageStore` | Where the counters are kept |
| `setUsageRetentionDays(days)` | 31 | Days the day counters are kept (minute counters: 2 minutes); pruned at most once an hour |
| `setOpenApi(source)` | empty document | The public document: an object, or a path to a JSON file (`public-api: cannot read OpenAPI document <path>` when unreadable) |
| `setServerUrl(url)` | the request's `scheme://host` plus the parent mount's prefix | The document's `servers` URL when it has none |
| `setBasePath(path)` | `/qcli/api` | Where the OpenAPI document and Swagger UI are served (`/segment[/segment]`; otherwise `invalid public-api base path: <path>`) |
| `setTitle(title)` | `API reference` | The portal's label for the API section |
| `build()` | | `{ prefix, router, cliRoutes: false, publicRoutes, guard(permission?), usage, store, portalSection, installedPlugin }` |

## Storage

The default store keeps the counters in memory, for one process. Several processes share their limits only through a shared store implementing `IPublicApiUsageStore`:

```typescript
interface IPublicApiUsageStore {
    increment(tokenId: string, userId: string, window: string): Promise<number>; // the token's new count
    decrement(tokenId: string, window: string): Promise<void>;
    accountCount(userId: string, window: string): Promise<number>; // every token of the user
    tokenDays(tokenIds: string[], fromDay: string, toDay: string): Promise<Record<string, Record<string, number>>>;
    prune(beforeDay: string, beforeMinute: string): Promise<void>;
}
```

A window is a UTC day (`2026-11-19`) or minute (`2026-11-19T23:59`). The guard increments the token's day and minute counters, reads the account's sums and takes the request back when a limit is exceeded, so processes sharing a store never admit more than the limit (under contention an extra request may be refused). Within one process an account's admissions run one at a time, so the limit admits exactly that many requests.

## In production

- **Middleware order.** On a protected server, a request to a public route of the portal, docs or public-api plugin under `/api` is answered inside the server's auth gate, which runs first. Middleware you add to the app after `createCliServer` (a rate limiter, request logging, compression) does not run for it; add such middleware before the CLI server's app, for example on a parent app (`outer.use(limiter); outer.use(cli.app)`).
- **Combining with the users plugin's guards.** `publicApi.guard(...)` and `usersPlugin.requirePermission(...)` / `requireHostToken(...)` can sit on one route, in either order. A request is counted only once it has passed the public-api guard. When a users guard after it refuses the request (401/403/500), the count and the `X-RateLimit-*` headers are taken back first, so the refused request is not counted (as with stacked public-api guards, through the same take-back slot). A refused request never carries `req.qcliCaller`, whichever guard refused it.
- **Set the URLs explicitly.** Without `setServerUrl`, the document's `servers` comes from the request's `Host` header (and the docs plugin's `{{baseUrl}}` likewise without `setBaseUrl`); behind a proxy or with clients sending any `Host`, set both.
- **"Try it" from another origin.** When the portal is served from another origin than the API, its "try it" calls are cross-origin: enable CORS on your API routes for the portal's origin, allow the `Authorization` header, and expose the rate-limit headers (`Access-Control-Expose-Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After`) so the reader sees them.
- **Stacked guards** (one on a router, another on a route) count a request once; each later guard only checks its own permission, and a request it refuses (403) is taken back, so it is not counted. Express gives the first guard no view of the later ones, so the take-back happens after the fact: between the first guard's count and a later guard's refusal, another request of the same account near its limit can briefly be refused (the .NET server checks every stacked permission before counting). A client that disconnects while its admission waits is not counted.
- A request that fails with 500 because the usage store failed is not left counted: the increments that succeeded are taken back (best effort).

## Tokens from one service

The users plugin checks token names and the 20-token limit in the process that creates the token. Several services may validate tokens over shared stores (a second service with `createCliServer({ cliRoutes: false })` and the users plugin's `setGuardOnly()`), but create and revoke tokens from one service only.

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install public-api`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into
`<dataDir>/server-plugins` and loads it at the next start ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)).
Its entry (`qodalis.entry`, `dist/plugin.js`) brings the host's public API: host tokens, one quota for every account, usage, the OpenAPI document and Swagger UI. The host's routes take the guard from the `public-api` service (`builder.pluginServices.get('public-api').guard('rates:read')`). Load order: `DEFAULT` (50), after the users plugin it builds on (the `users` service: added in code, mounted, or installed).

| Setting | Type | Default | | |
|---|---|---|---|---|
| `basePath` | string | `/qcli/api` | required | Where the OpenAPI document and Swagger UI are served |
| `title` | string | `API reference` | required |  |
| `openApiFile` | string | — |  | A JSON file (relative paths from the plugin's data directory); empty: an empty document |
| `serverUrl` | string | — |  | The document's servers URL; empty: the request's |
| `requestsPerDay` | number | `0` |  | Per account; 0: unlimited |
| `requestsPerMinute` | number | `0` |  | Per account; 0: unlimited |
| `usageRetentionDays` | number | `31` |  |  |

Every setting needs a restart. Set them on the Config page or with `config set public-api.settings.<key> <value>`, then
restart. Without the users plugin it is `needs-configuration`. A plugin waiting for a required setting is `needs-configuration`: it registers nothing, is listed
with that status and its `missing` settings (installed.json, `GET /api/v1/qcli/server/marketplace/installed`, the
installed plugins), and runs once they are saved and the server restarts. Secrets are kept by the config store
(`<dataDir>/plugin-settings.json` while the server keeps its settings in memory), never returned (`isSet` only).
The marketplace reads these settings from `qodalis.config` of the package.json (`npm run sync:plugin-config`).

## Install in code

The same entry and settings: `builder.addPlugin(entry, options)` runs it with the plugins installed at runtime, in
load order. Options of a setting's key are its defaults (origin `code` on the Config page and in `config get`); a
saved setting overrides them at the next start. Read from code only: `quota` (a function per account, wins over the two quota settings), `usageStore`, `openApi` (an object), `users`.

```ts
import { publicApiPluginEntry } from '@qodalis/cli-server-plugin-public-api';

const cli = createCliServer({
    configure: (builder) => builder.addPlugin(publicApiPluginEntry, { basePath: '/qcli/api', requestsPerDay: 1000 }),
});
await cli.serverPlugins.ready(); // before listening
```

The builder API above (`mountPlugin`) keeps working; it does not expose the settings.

