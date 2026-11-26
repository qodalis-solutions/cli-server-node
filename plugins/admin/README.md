# @qodalis/cli-server-plugin-admin

Admin dashboard plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Provides JWT authentication, server status, plugin management, configuration, log viewing, and WebSocket client monitoring via a REST API and bundled SPA dashboard.

## Install

```bash
npm install @qodalis/cli-server-plugin-admin
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { CliAdminBuilder } from '@qodalis/cli-server-plugin-admin';

const { app, registry, builder, eventSocketManager, eventBus } = createCliServer({
    configure: (builder) => {
        // register your modules...
    },
});

const adminPlugin = new CliAdminBuilder()
    .setCredentials('admin', 'my-secret-password')
    .setJwtSecret('my-jwt-secret')
    // eventBus: log entries are published as `log:entry` (audience `logs:read`)
    .build({ registry, eventSocketManager, builder, eventBus });

// Using createCliServer:
mountPlugin(adminPlugin);

// Or on an existing Express app:
app.use(adminPlugin.prefix, adminPlugin.router);
app.use(adminPlugin.dashboardPrefix, adminPlugin.dashboardRouter);
```

## Configuration

When the users plugin is installed, pass `setAuthProvider(usersPlugin.serverAuth)`: the dashboard then logs in with users credentials, its token is a users session token, and every admin route requires `admin:access`. The static credentials below are only used when the users plugin is absent.

Credentials and JWT secret can be set via the builder or environment variables:

| Environment Variable | Default | Description |
|---|---|---|
| `QCLI_ADMIN_USERNAME` | `admin` | Admin login username |
| `QCLI_ADMIN_PASSWORD` | `admin` | Admin login password |
| `QCLI_ADMIN_JWT_SECRET` | Random | JWT signing secret |

## Builder Options

| Method | Description |
|---|---|
| `setCredentials(username, password)` | Set admin login credentials (only used without the users plugin) |
| `setAuthProvider(usersPlugin.serverAuth)` | Log in through the users plugin; requires the `admin:access` permission (`admin` has it via `*`) |
| `setJwtSecret(secret)` | Set JWT signing secret |
| `setSignInUrl(url)` | Where the host app signs users in, for external sign-in mode (see [Sign in with the host app's session](#sign-in-with-the-host-apps-session)); `build()` throws on an invalid URL |
| `setRegisteredJobs(count)` | Report job count in the status endpoint (`jobs` is listed in `enabledFeatures` once the jobs plugin is mounted, or with a count above 0) |
| `setEnabledFeatures(features)` | Add custom feature flags to the status endpoint |
| `setDashboardDir(dir)` | Override the path to the dashboard SPA dist directory |
| `setTheme(theme)` | Dashboard color scheme: mode and per-scheme colors (see [Color scheme](#color-scheme)) |
| `setBranding(branding)` | Dashboard name and icon, and its terminal's name (see [Name and icon](#name-and-icon)) |
| `setMarketplace({ url, install, dir, fetch })` | Dashboard plugins from the marketplace (see [Dashboard plugins from the marketplace](#dashboard-plugins-from-the-marketplace)); `false` turns them off |

## REST API

All endpoints are mounted at the plugin's built-in prefix (`/api/v1/qcli`). Routes below `/auth/login` require a valid JWT in the `Authorization: Bearer <token>` header.

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| GET | `/auth/mode` | Public. Which sign-in the dashboard shows: `{ "mode": "password" \| "external", "signInUrl": string \| null }` (`Cache-Control: no-store`) |
| POST | `/auth/login` | Authenticate with username/password, receive JWT (501 in external mode) |
| GET | `/auth/me` | Get current user info from token |

### Status

| Method | Endpoint | Description |
|---|---|---|
| GET | `/status` | Server uptime, process memory (`memoryUsageMb`), the machine's memory (`systemMemoryTotalMb`, `systemMemoryUsedMb`, `memoryLimited`), CPU (latest sample), platform, connections, registered commands, enabled features (`filesystem`, `jobs`, `audit` with the audit plugin, which the users plugin adds) |
| GET | `/status/history` | Status samples of the last `?minutes=` (default 60, 1-1440), oldest first: `{ intervalSeconds: 15, samples: [{ timestamp, memoryMb, systemMemoryUsedMb, systemMemoryTotalMb, cpuPercent, activeWsConnections, activeShellSessions }] }` |

The plugin samples the status every 15 seconds (the first at build) and keeps 24 hours in memory (lost on restart). `cpuPercent` is the process CPU time over the last interval as a percentage of one core (null for the first sample). The timer never keeps the process alive; `dispose()` stops it.

`systemMemoryTotalMb` is the RAM the server can use: the container (cgroup) limit when one is set below the installed RAM (`process.constrainedMemory()`), then `memoryLimited` is true, otherwise the installed RAM (`os.totalmem()`). `systemMemoryUsedMb` is the memory in use: the container's usage when limited (cgroup v2 `memory.current`, v1 `memory.usage_in_bytes`), otherwise the machine's (`os.totalmem() - os.freemem()`). Each is null when it cannot be read.

### Plugins

| Method | Endpoint | Description |
|---|---|---|
| GET | `/plugins` | List all registered modules, and the commands added on their own grouped by their `module` (see [Command modules](#command-modules)) |
| GET | `/plugins/:id` | One module (case-insensitive id); 404 when unknown |
| GET | `/plugins/installed` | The installed server plugin packages (`id`, `name`, `version`, `description`), the server (`Core`) first |
| POST | `/plugins/:id/toggle` | Enable or disable a module (its commands answer as unknown while disabled) |

The built-in plugins list themselves when added (`mountPlugin` for users, admin and jobs; `addModule`, `setFileStorageProvider`/`addFileSystem` and `addDataExplorerProvider` for modules and providers). A plugin of your own calls `builder.addInstalledPlugin(__dirname)` (reads the nearest `package.json`) or `builder.addInstalledPlugin({ id, name, version, description })`; modules and providers can instead carry the description under `CLI_INSTALLED_PLUGIN` (`@qodalis/cli-server-abstractions`).

### Configuration

When the users plugin is installed, pass `setAuthProvider(usersPlugin.serverAuth)`: the dashboard then logs in with users credentials, its token is a users session token, and every admin route requires `admin:access`. The static credentials below are only used when the users plugin is absent.

The Config page shows the server's [config providers](../../README.md#config-providers) (`builder.config`): the
server's built-in ones, the plugins' and the host's. The former hardcoded sections are providers now: `server`
(core), `auth` and `custom` (core, on the server's config store). The plugin adds two providers when built:

- `auth` (read-only): `admin.mode` (`password`, `users`, `external`), `username`, `defaultCredentials`, `jwtSecretConfigured`, `signInUrl` (never a password or the secret);
- `logs`: `buffer.capacity` (entries kept, 100-100000) and `buffer.minLevel` (`DEBUG`, `INFO`, `WARN`, `ERROR`), changed at runtime; kept in the server's default config store, or in its own with `new CliAdminBuilder().setConfigStore(store)`.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/config` | `{ defaultStore, providers: [...] }`: the store providers use unless they have their own (`{ kind, title, detail, persistent }`) and the providers the caller may see (`config:read`), each with its `storage` and, when it saves to a store, its `store`, secrets masked |
| GET | `/config/{provider}` | One provider with its `store` (404 unknown, 403 without its `requiredPermission`) |
| PATCH | `/config/{provider}/{section}` | `{ changes, version? }` (`config:write`): 200 with the section, 400 `{ error, errors }` per key, 409 `{ error, version }` for a stale version |

The former `PUT /config` is gone. With the static credentials the admin holds every permission; with the users
plugin the session's permissions apply (`config:read`, `config:write`, and the server's gate checks them too:
`routePermissions` of the plugin result). The plugin result's `configProviders` lists `auth` and `logs`.

### Logs

| Method | Endpoint | Description |
|---|---|---|
| GET | `/logs` | Query log entries, oldest first, with optional `level` (one or several, comma-separated), `search` (message or source), `service` (source), `from`/`to` (ISO 8601, `from <= timestamp < to`), `limit`, `offset` params → `{ entries, total, store: "memory", persistent: false, limit, offset, hasMore, services }` (`services`: the distinct sources in the buffer) |
| GET | `/logs/histogram` | Entries per level (`DEBUG`, `INFO`, `WARN`, `ERROR`) in equal columns of `?from=&to=` (ISO 8601, default the last 24 hours), `buckets=` (1-200, default 24), with the filters of `/logs` → `{ from, to, bucketMs, buckets: [{ start, DEBUG, INFO, WARN, ERROR }], totals, store: "memory" }` |

The log buffer captures `console.log`/`warn`/`error` output. As a safety net, a value written after a `password`, `passwd`, `secret` or `token` label (`password: x`, `token=x`, `password for user "root": x`) is replaced with `[REDACTED]` before the entry is stored or broadcast.

### WebSocket Clients

| Method | Endpoint | Description |
|---|---|---|
| GET | `/ws/clients` | List connected WebSocket clients |

### Sign in with the host app's session

The full setup (adapter, middleware order, permissions) is in [Use with your app's sign-in](../../README.md#use-with-your-apps-sign-in).

When the users plugin delegates authentication to your application (`setAuthAdapter`), the dashboard runs in **external** mode. The users plugin sets the server's `serverOptions.externalAuthentication` when it is mounted (`mountPlugin(usersPlugin)` or `createCliServer({ auth })`), and the admin plugin reads it on every request, so the mounting order does not matter.

- `GET /api/v1/qcli/auth/mode` answers `{ "mode": "external", "signInUrl": "<setSignInUrl>" }`. It is public, also on protected servers, so the dashboard can call it before anyone signs in. Otherwise it answers `"password"`.
- The dashboard hides its username/password form and shows "Sign in at `<signInUrl>`" with a Retry button (or tells users to sign in through the host application when no sign-in URL is set). Any 401 leads to that screen.
- The dashboard sends users back: it fills `{returnTo}` in the sign-in URL (`/sign-in?next={returnTo}`), or appends a `returnTo=` parameter, with the dashboard page they were on (e.g. a terminal link's approval page). After signing in, the host opens that URL with `#token=<bearer token>`.
- `POST /api/v1/qcli/auth/login` signs no one in: it answers `501` with `code: "EXTERNAL_AUTH"`, a message pointing to the host's sign-in and `signInUrl`. The static admin credentials are never accepted in this mode.
- With `setAuthProvider(usersPlugin.serverAuth)`, admin routes authenticate the request through the users plugin (your adapter) and require `admin:access` (`isAdmin` grants it through the `admin` group).

The sign-in URL must be an absolute `http`/`https` URL or a root-relative path (`/sign-in`); anything else (for example `javascript:` or `//host`) makes `build()` throw.

**Handoff.** Send signed-in users to the dashboard with your bearer token in the URL fragment:

```
/qcli/admin/#token=<host bearer token>
```

A fragment is never sent to servers or written to access logs. The dashboard reads it on startup, stores it as its admin token, removes it from the address bar (`history.replaceState`) and sends it as `Authorization: Bearer …` on every API call, where your external auth adapter validates it like any other request from your app.

```typescript
// Host app: the adapter accepts the app's own JWT (verified by your middleware, which sets req.user).
const usersPlugin = new CliUsersBuilder()
    .setAuthAdapter((req) => {
        const principal = (req as any).user;
        if (!principal) return null;
        return { user: { id: principal.sub, name: principal.name, email: principal.email ?? '', groups: [], createdAt: 0, updatedAt: 0 }, isAdmin: principal.roles?.includes('admin') };
    })
    .build((msg) => eventSocketManager.broadcastMessage(msg));

const adminPlugin = new CliAdminBuilder()
    .setAuthProvider(usersPlugin.serverAuth)
    .setSignInUrl('/sign-in?returnUrl=%2Fadmin%2Fconsole')
    .build({ registry, eventSocketManager, builder });

mountPlugin(adminPlugin);
mountPlugin(usersPlugin);
```

```ts
// Host front end: an "Open console" button for a signed-in admin.
window.location.href = `/qcli/admin/#token=${encodeURIComponent(accessToken)}`;
```

When the token expires, the next API call answers 401 and the dashboard shows the sign-in screen; after signing in again, the host repeats the handoff.

## Dashboard

The plugin includes a bundled SPA dashboard served at the built-in prefix (`/qcli/admin`). The dashboard is found in this order: the directory given to `setDashboardDir()`, a sibling `cli-server-dashboard/dist` build (development), the package's bundled `dashboard/` directory, and the `@qodalis/cli-server-dashboard` package if installed separately. The same order applies whether the plugin runs compiled or from source (`tsx`).

## Dashboard plugins from the marketplace

A *dashboard plugin* is an npm package whose bundle is a dashboard extension (`extension.js`, optional
`extension.css`, built with `@qodalis/cli-server-dashboard-kit`'s `defineExtension`), listed in the
[plugin marketplace](https://plugins.qodalis.com) with `kind: "dashboard"`. The admin plugin lists them, installs,
updates and removes them at runtime, and serves them from the server's own origin. A plugin runs inside the dashboard
with the signed-in user's rights, so by default only verified publishers' plugins can be installed.

```ts
new CliAdminBuilder()
    .setAuthProvider(usersPlugin.serverAuth)
    .setMarketplace({
        url: 'https://plugins.qodalis.com', // default
        install: 'verified', // default; 'listed': any listed version; 'off': browse only
        dir: './qcli-data/dashboard-plugins', // default, from the working directory
    })
    .build({ registry, eventSocketManager, builder });
```

| Option | Default | Description |
|---|---|---|
| `url` | `https://plugins.qodalis.com` | The marketplace (its public API at `/api/v1/qcli/marketplace`) |
| `install` | `verified` | `verified`: listed versions of verified publishers only; `listed`: any listed version; `off`: browse only |
| `dir` | `./qcli-data/dashboard-plugins` | Where installed plugins are kept |
| `fetch` | global `fetch` | The HTTP client for the marketplace and the CDNs (tests pass a fake) |
| `cdns` | jsDelivr, unpkg | Where bundles are downloaded from, in order |
| `timeoutMs` | `15000` | Timeout of each request |

`setMarketplace(false)` serves none of the routes below and loads no installed plugin.

**Installing** resolves the version (the newest listed one this dashboard runs, `dashboardApi` 1, unless one is
given), checks the trust policy, downloads each file of the version record (`files: [{ path, integrity, size }]`) from
jsDelivr, then unpkg (5 MB at most each), and checks its bytes against the marketplace's `sha384-` integrity before
anything is written: a mismatch on every CDN is a 502 and stores nothing. The files are stored as
`<dir>/<name>/<version>/extension.js|css` (a scoped name `@scope/name` as the directory `@scope+name`; names and
versions are validated, so nothing leaves `dir`) and listed in `<dir>/installed.json`, written atomically (a temporary
file renamed over it):

```json
{
  "plugins": [
    {
      "name": "@qodalis/cli-dashboard-module-jobs",
      "version": "1.1.0",
      "id": "jobs",
      "title": "Jobs",
      "icon": "⏱️",
      "files": [
        { "file": "extension.js", "path": "dist/extension.js", "integrity": "sha384-…", "size": 48211 },
        { "file": "extension.css", "path": "dist/extension.css", "integrity": "sha384-…", "size": 5120 }
      ],
      "installedAt": "2026-11-25T10:04:05.123Z",
      "installedBy": "admin",
      "config": { "entries": [{ "key": "refreshSeconds", "type": "number", "default": 30, "validation": { "min": 5, "max": 3600 } }] }
    }
  ]
}
```

`config` (the installed version's settings, see [Settings of dashboard plugins](#settings-of-dashboard-plugins)) is
absent for a plugin without settings.

The plugin is then registered as a dashboard extension at once (no restart): its page id is the package's suffix for
`@qodalis/cli-dashboard-module-<id>`, else the extension's own id (the marketplace record's `extension.id`), else the
package name without its scope and `cli-dashboard-` prefix. An id another extension already has is a 409. Its files
are served at `/qcli/modules/<id>/extension.js|css` (no sign-in, `Cache-Control: no-cache` with an ETag, the entry
carrying `?v=<hash>`), and `GET /dashboard/extensions` lists it with `source: "marketplace"` and its npm `package`. An update keeps the page
id and deletes the previous version's files; a removal unregisters the page and deletes the files.

At startup the plugin registers what `installed.json` lists, without the marketplace; a plugin whose files are missing
or no longer match their integrity, or whose id another extension took, is skipped with a warning. Plugins mounted
after the admin plugin cannot take a marketplace page's id, so mount the admin plugin after the plugins with pages of
their own.

Every change is audited (`dashboard.plugin.install`, `dashboard.plugin.update`, `dashboard.plugin.remove`: target the
package, `properties: { name, version, id, previousVersion?, config?, configDropped? }`, the keys of the settings given
and dropped) in the users plugin's audit log (or the store set with
`builder.setConfigAuditStore`) and published as `dashboard:extensions-changed`
(`{ action, name, version, id, previousVersion? }`, audience `admin:access`), so open dashboards reload their pages.

### Settings of dashboard plugins

A dashboard plugin may declare settings with defaults, in the config providers' entry model: `qodalis.config.entries`
of its package.json, published by the marketplace as `config: { entries }` of the version record:

```json
{
  "entries": [
    { "key": "refreshSeconds", "label": "Refresh every", "type": "number", "default": 30, "validation": { "min": 5, "max": 3600 } },
    { "key": "columns", "type": "string[]", "default": ["name", "status"] },
    { "key": "mode", "type": "enum", "default": "compact", "validation": { "options": ["compact", "full"] } }
  ]
}
```

Types `string`, `number`, `boolean`, `string[]`, `enum`, `json`, `duration` and `url`, **never `secret`** (a dashboard
plugin runs in the browser: it cannot keep one). Keys match `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`, at most 50 entries, an
`enum` has `validation.options`, every default passes its own validation, at most 32 KB of JSON. The marketplace
rejects versions breaking these rules; the server checks them again (`parseDashboardPluginConfig`), and a version
whose settings fail installs **without settings**, the response carrying
`"warnings": ["the settings of <name>@<version> are invalid and were ignored: <reason>"]`. Settings missing from the
details' versions are read from the version record.

The admin plugin registers the config provider **`dashboard-plugins`** ("Dashboard plugins", writable,
`DashboardPluginsConfigProvider`) with **one section per installed plugin with settings**: the section id is the page
id, its title the plugin's title, its entries the installed version's with their defaults. A plugin without settings
gets no section. Its store is resolved like every provider's: the host's store for `dashboard-plugins`
(`createCliServer({ config: { stores: { 'dashboard-plugins': store } } })`, `builder.setConfigStore(store,
'dashboard-plugins')`), else the default store, else memory. `GET /api/v1/qcli/config/dashboard-plugins`:

```json
{
  "id": "dashboard-plugins",
  "title": "Dashboard plugins",
  "description": "Settings of the dashboard plugins installed from the marketplace",
  "order": 85,
  "writable": true,
  "storage": { "kind": "store", "description": "Changes are saved to its config store", "sources": [] },
  "store": { "kind": "file", "title": "JSON file", "detail": "qcli-config.json", "persistent": true },
  "sections": [
    {
      "id": "tickets",
      "title": "Tickets",
      "description": "@acme/cli-dashboard-tickets@1.0.0",
      "mutable": true,
      "version": "1",
      "allowCustomKeys": false,
      "entries": [
        { "key": "refreshSeconds", "label": "Refresh every", "description": "", "type": "number", "value": 60, "default": 30, "source": "file", "mutable": true, "requiresRestart": false, "sensitive": false, "validation": { "min": 5, "max": 3600 } },
        { "key": "columns", "label": "columns", "description": "", "type": "string[]", "value": ["name", "status"], "default": ["name", "status"], "source": "default", "origin": "default", "mutable": true, "requiresRestart": false, "sensitive": false },
        { "key": "mode", "label": "mode", "description": "", "type": "enum", "value": "compact", "default": "compact", "source": "default", "origin": "default", "mutable": true, "requiresRestart": false, "sensitive": false, "validation": { "options": ["compact", "full"] } }
      ]
    }
  ]
}
```

Settings are changed like any other: `PATCH /api/v1/qcli/config/dashboard-plugins/<id>` (`config:write`), `config set
dashboard-plugins.<id>.<key> <value>`, MCP `config_set`; the same validation (400 with per-key errors), versions (409),
audit (`config.update`) and `config:changed` event.

- **Install**: `POST /installed` takes `config: { key: value }`, checked against the version's settings **before
  anything is downloaded or stored** (400 `{ "error": "validation failed", "errors": { "refreshSeconds": "must be at
  least 5", "nope": "unknown setting" } }`; `config must be an object` for anything else) and stored with the install
  (`null` keeps the default). Values left in the store for that page id by an earlier install are cleared.
  Install-time values need `dashboard:install`, not `config:write`.
- **Update**: `PUT /installed/{name}` takes `config` too, checked against the new version's settings. Stored values
  whose key the new version still has and whose value it still accepts are kept, the others deleted and listed in the
  response as `configDropped` (`[]` when none); a value given for a key replaces it, `null` resets it. The same version
  with `config` applies the values. A version without settings removes the section.
- **Remove**: deletes the section and every value stored for it.
- **Restart**: the sections are re-created from `installed.json` (it keeps each installed version's `config`), so
  they come back offline with their stored values.
- Changing stored values publishes `config:changed` (`{ provider: "dashboard-plugins", section, keys, version,
  requiresRestart: false, store, user }`, audience `config:read`).

The page reads its values from `GET /installed/{name}/config` (`admin:access`): the stored values over the defaults
and the section's version, `{ "values": {}, "version": null }` for a plugin without settings, 404 when not installed:

```json
{ "values": { "refreshSeconds": 60, "columns": ["name", "status"], "mode": "compact" }, "version": "1" }
```

### Marketplace API

Mounted at `/api/v1/qcli/dashboard/marketplace`. Reading needs `admin:access`; `POST`, `PUT` and `DELETE` need
`dashboard:install` (core catalog, group Server; the static admin of password sign-in holds every permission). Errors
are `{ "error": "..." }` (with `errors`, per key, when settings are refused).

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | `{ "marketplaceUrl": "https://plugins.qodalis.com", "install": "verified", "dashboardApi": 1 }` |
| GET | `/plugins?query=&page=&pageSize=` | The marketplace's `kind=dashboard` list (`{ items, total, page, pageSize }`), each item annotated (below); 502 `{ "error": "marketplace unreachable" }` |
| GET | `/plugins/{name}` | One plugin with its `versions`, annotated; each version also `allowed` and `blockedReason`; 404 when not listed |
| GET | `/installed` | The installed plugins (below); `updateAvailable` when the marketplace answers |
| GET | `/installed/{name}/config` | `{ values, version }`: the values of its settings (stored over defaults) and the section's version; `{ values: {}, version: null }` without settings |
| POST | `/installed` | `{ name, version?, config? }`: 201 with the installed plugin (`warnings` when its settings were ignored); 400 invalid name or version, `needs dashboard API 2`, `validation failed` with `errors`; 403 `publisher not verified`, `install disabled`; 404 unknown plugin or version; 409 already installed, id taken; 502 `marketplace unreachable`, `integrity mismatch: <path>`, `download failed: <path>` |
| PUT | `/installed/{name}` | `{ version?, config? }`: updates (default: the newest fitting version), same checks; the plugin with `configDropped`; 404 when not installed |
| DELETE | `/installed/{name}` | Removes the plugin and its settings; 404 when not installed |

Scoped names go in the path raw (`/installed/@acme/tickets`) or encoded (`/installed/%40acme%2Ftickets`).

A `GET /plugins` item is the marketplace's item plus:

```json
{
  "name": "@qodalis/cli-dashboard-module-jobs",
  "kind": "dashboard",
  "publisher": { "name": "@qodalis", "verified": true },
  "version": "1.1.0",
  "installed": { "version": "1.0.0" },
  "updateAvailable": true,
  "allowed": true,
  "requires": { "serverPackage": "@qodalis/cli-server-plugin-jobs", "installed": true }
}
```

`installed` is null when not installed; `blockedReason` (only when `allowed` is false) is `install disabled`,
`unverified publisher` or `needs dashboard API <n>` (a version of the details may also be `version flagged`);
`requires` is null when the plugin names no Node server package (`serverPackages.node`), else whether the server has
it (`GET /plugins/installed`).

`GET /installed`:

```json
[
  {
    "name": "@qodalis/cli-dashboard-module-jobs",
    "version": "1.1.0",
    "title": "Jobs",
    "icon": "⏱️",
    "id": "jobs",
    "installedAt": "2026-11-25T10:04:05.123Z",
    "installedBy": "admin",
    "hasConfig": false,
    "updateAvailable": false
  }
]
```

`hasConfig`: the plugin has settings (the section `dashboard-plugins.<id>`).

## Server plugins from the marketplace

The marketplace's server plugins (`kind=server`) have a package per server platform (Node, Python, .NET). This server
lists and installs only the **Node** package; the others show as `otherPlatforms`. Same `setMarketplace` options and
trust policy as dashboard plugins (`verified` by default), plus `npmRegistry` (default `https://registry.npmjs.org`)
and `npm` (the runner; tests pass a fake).

An install:

1. resolves the plugin and the version (the newest listed one whose `serverRange` this server's version satisfies, or
   the one asked for), refusing an unverified publisher (403), a plugin without a Node package, one whose npm record or
   package says `"autoInstall": false` (400 `needs setup in code: <reason>`), an incompatible range (400
   `incompatible: ... needs server <range> (this server has <version>)`) and a package the host installed in code (409);
2. reads the npm record (`<registry>/<package>/<version>`): its `dist.integrity` (sha512) must equal the marketplace's
   `integrity` when it has one;
3. downloads the tarball (50 MB at most) and checks its sha512 (502 `integrity mismatch: ...`, nothing stored), then its
   `package.json`: name and version, `qodalis.kind: "server"`, an `entry`, no `autoInstall: false`, and a range on
   `@qodalis/cli-server-node` or `-abstractions` this server satisfies;
4. runs `npm install <dataDir>/server-plugins/tarballs/<name>-<version>.tgz --prefix <dataDir>/server-plugins
   --no-audit --no-fund --ignore-scripts` (the verified local file; it stays, npm's `package.json` refers to it);
5. records the plugin in `<dataDir>/server-plugins/installed.json` (written atomically) and marks a restart as required
   (`plugin:<name>`, source `plugins`, `Install <name> <version>`); audit `server.plugin.install`, event
   `server:plugins-changed` (audience `admin:access`).

The server loads it at the next start ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). An update
works the same way; a removal runs `npm uninstall`. Each marks the restart, or clears it when the installed list is back
to what the server runs (an install removed before a restart, an update back to the running version).

### Server marketplace API

Mounted at `/api/v1/qcli/server/marketplace`. Reading needs `admin:access`; `POST`, `PUT` and `DELETE` need
**`plugins:install`** (core catalog, group Server; `dashboard:install` is for dashboard plugins only).

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | `{ "marketplaceUrl": "https://plugins.qodalis.com", "install": "verified", "platform": "node", "serverVersion": "1.0.0-beta.31", "enabled": true }` (`enabled`: false with `createCliServer({ serverPlugins: false })`) |
| GET | `/plugins?query=&page=&pageSize=` | The marketplace's `kind=server&platform=node&serverVersion=<this>` list, annotated (below); 502 `marketplace unreachable` |
| GET | `/plugins/{name}` | One plugin: every platform's versions (`versions`, each with `platform`), the Node ones with `allowed` and `blockedReason`; `autoInstall` from the newest Node package's npm record |
| GET | `/installed` | The installed plugins and how they run (below) |
| POST | `/installed` | `{ name, version? }`: **202** with the installed plugin and `restartRequired` |
| PUT | `/installed/{name}` | `{ version? }`: 202 (`changed`, `previousVersion`), 200 with `changed: false` when it already is that version |
| DELETE | `/installed/{name}` | 202; the plugin keeps running until the restart (`status: "removed"`) |

A `GET /plugins` item is the marketplace's item plus:

```json
{
  "name": "weather",
  "kind": "server",
  "title": "Weather",
  "publisher": { "id": "@qodalis", "name": "qodalis", "verified": true },
  "platforms": {
    "node": { "package": "@qodalis/cli-server-plugin-weather", "registry": "npm", "latest": "1.1.0", "install": "npm install @qodalis/cli-server-plugin-weather" },
    "python": { "package": "qodalis-cli-server-plugin-weather", "registry": "pypi", "latest": "1.0.0b31", "install": "pip install qodalis-cli-server-plugin-weather" }
  },
  "latest": "1.1.0",
  "compatible": true,
  "platform": { "package": "@qodalis/cli-server-plugin-weather", "latest": "1.1.0", "installed": null, "compatible": true },
  "otherPlatforms": ["python", "dotnet"],
  "autoInstall": true,
  "updateAvailable": false,
  "allowed": true
}
```

`platform` is null without a Node package; `reason` (when not `compatible`) is the marketplace's, e.g. `needs server
^99.0.0 (this server has 1.0.0-beta.31)`. `blockedReason` (only when `allowed` is false): `server plugins disabled`,
`install disabled`, `unverified publisher`, `not available for node`, `needs setup in code` (with `autoInstallReason`),
or the range's reason.

`GET /installed` (and the body of `POST`, `PUT`, `DELETE` with `restartRequired`):

```json
[
  {
    "name": "weather",
    "package": "@qodalis/cli-server-plugin-weather",
    "version": "1.1.0",
    "title": "Weather",
    "icon": "🌤️",
    "description": "The weather plugin",
    "installedAt": "2026-11-25T10:04:05.123Z",
    "installedBy": "admin",
    "status": "pending",
    "loadedVersion": "1.0.0",
    "updateAvailable": false
  },
  {
    "name": "users-postgres",
    "package": "@qodalis/cli-server-plugin-users-postgres",
    "version": "1.0.0-beta.31",
    "title": "Users on PostgreSQL",
    "icon": "🐘",
    "description": null,
    "installedAt": "2026-11-25T10:06:00.000Z",
    "installedBy": "admin",
    "status": "needs-configuration",
    "loadedVersion": "1.0.0-beta.31",
    "missing": ["settings.connectionString"],
    "settings": "users-postgres"
  }
]
```

`status`: `loaded` (runs this version), `needs-configuration` (running, but its required settings have no value:
`missing` lists them as `<section>.<key>` or a reason; it registered nothing, save them on the Config page or with
`config set`, then restart), `pending` (installed or updated, runs after a restart), `failed` and `skipped` (the last
start could not load it, or the host installed the same package: `error`), `removed` (removed, running until a
restart). `settings`: the id of its config provider (`GET /api/v1/qcli/config/<id>`), once it registered one.

`installed.json`:

```json
{
  "plugins": [
    {
      "name": "weather",
      "package": "@qodalis/cli-server-plugin-weather",
      "version": "1.1.0",
      "integrity": "sha512-…",
      "title": "Weather",
      "icon": "🌤️",
      "installedAt": "2026-11-25T10:04:05.123Z",
      "installedBy": "admin",
      "settings": "weather"
    }
  ]
}
```

A plugin the last start found without a required setting keeps `"status": "needs-configuration"` and `"missing"` there
(cleared once it loads).

## Color scheme

Match the dashboard to your own design with `setTheme()`:

```typescript
const adminPlugin = new CliAdminBuilder()
    .setCredentials('admin', 'my-secret-password')
    .setTheme({
        mode: 'system',
        light: {
            primary: '#2a6bba', primaryHover: '#1f5596', accent: '#2a6bba',
            background: '#f1f6fa', backgroundAccent: '#f1f6fa', surface: '#ffffff',
            border: '#d9e3ec', heading: '#142231', text: '#142231', muted: '#5d6f82',
        },
        dark: {
            primary: '#4f9be0', primaryHover: '#3f8ad3', onPrimary: '#0d1823', accent: '#4f9be0',
            background: '#0d1823', backgroundAccent: '#0d1823', surface: '#13212f', popover: '#13212f',
            border: '#22364a', text: '#e6eef6', muted: '#93a6b9',
        },
    })
    .build({ registry, eventSocketManager, builder, executor });
```

`setTheme()` throws on an invalid theme. The types (`AdminTheme`, `AdminThemeColors`, `AdminThemeMode`) and
`validateAdminTheme()` are exported.

`mode` is `dark` (default), `light`, or `system` to follow the browser's `prefers-color-scheme`. Each scheme takes any
subset of the tokens below; the ones you leave out keep their defaults.

Values must be plain CSS colors: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), a color function with numeric arguments
(`rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`) or a named color. Anything else
(an unknown mode or token, `var()`, `url()`, `;` ...) is rejected at startup with an error naming the token, so a theme
cannot inject CSS.

The plugin serves the validated scheme at `GET /qcli/admin/theme.json` (public, like the dashboard files, since the
sign-in page uses it), e.g. `{"mode":"system","dark":{"primary":"#4f9be0"},"light":{"primary":"#2a6bba"}}`. The
dashboard applies it before its first render.

The defaults match the Qodalis CLI panel: its grays, indigo accent with the violet glow, and status colors in dark; the same palette for light backgrounds in light.

| Token | CSS variable | Used for | Dark default | Light default |
| --- | --- | --- | --- | --- |
| `primary` | `--qcli-primary` | Primary buttons, active navigation, toggles, focus rings | `#818cf8` | `#4f46e5` |
| `primaryHover` | `--qcli-primary-hover` | Primary buttons on hover | `#a5b4fc` | `#4338ca` |
| `onPrimary` | `--qcli-on-primary` | Text and icons on `primary` | `#111827` | `#ffffff` |
| `accent` | `--qcli-accent` | Highlighted text: links, command names, active items | `#a78bfa` | `#7c3aed` |
| `background` | `--qcli-background` | Page background | `#111827` | `#f9fafb` |
| `backgroundAccent` | `--qcli-background-accent` | Start of the page background gradient (set it to `background` for a flat page) | `#1f2937` | `#eef2ff` |
| `sidebar` | `--qcli-sidebar` | Sidebar background | `#1f2937` | `#ffffff` |
| `surface` | `--qcli-surface` | Cards, panels and tables | `rgba(255, 255, 255, 0.04)` | `#ffffff` |
| `popover` | `--qcli-popover` | Dialogs and dropdown menus (opaque) | `#1f2937` | `#ffffff` |
| `control` | `--qcli-control` | Inputs, secondary buttons, chips | `rgba(255, 255, 255, 0.06)` | `rgba(17, 24, 39, 0.05)` |
| `controlHover` | `--qcli-control-hover` | Inputs and secondary buttons on hover | `rgba(255, 255, 255, 0.1)` | `rgba(17, 24, 39, 0.1)` |
| `border` | `--qcli-border` | Borders and dividers | `#374151` | `#e5e7eb` |
| `overlay` | `--qcli-overlay` | Backdrop behind dialogs | `rgba(0, 0, 0, 0.6)` | `rgba(17, 24, 39, 0.45)` |
| `heading` | `--qcli-heading` | Headings and values | `#ffffff` | `#111827` |
| `text` | `--qcli-text` | Body text | `rgba(255, 255, 255, 0.87)` | `#1f2937` |
| `muted` | `--qcli-muted` | Secondary text and labels | `rgba(255, 255, 255, 0.6)` | `#4b5563` |
| `subtle` | `--qcli-subtle` | Hints, placeholders, timestamps | `rgba(255, 255, 255, 0.4)` | `#6b7280` |
| `success` | `--qcli-success` | Success states | `#3fb950` | `#1a7f37` |
| `warning` | `--qcli-warning` | Warning states | `#f0883e` | `#bc4c00` |
| `error` | `--qcli-error` | Errors and destructive actions | `#f85149` | `#cf222e` |
| `info` | `--qcli-info` | Informational states | `#58a6ff` | `#0969da` |

## Command modules

The Plugins page also lists the command modules, each with its commands and a switch that disables them
(`/api/v1/qcli/plugins`). A module added with `builder.addModule(...)` is listed with its name, version, description and
`icon` (one emoji or an image URL). Commands registered on their own (`builder.addProcessor(...)`) are listed under the
module their `module` property names (case-insensitive). To describe such a group, add a module of the same name with
no processors of its own:

```typescript
class ShopModule extends CliModule {
    name = 'shop';
    version = '1.0.0';
    description = 'Shop administration';
    icon = '🛒';
    processors = []; // StatsCommand etc. set module = 'shop'
}

builder.addModule(new ShopModule())
    .addProcessor(new StatsCommand())
    .addProcessor(new OrdersCommand());
```

A group without such a module takes its version and author from its first command and has no description or icon.

## Name and icon

By default the dashboard is "Qodalis Cli Admin" with the Qodalis Solutions logo. An application that ships it
under its own name sets `setBranding()`:

```ts
new CliAdminBuilder().setBranding({
    name: 'RateBell',          // browser tab, sidebar, sign-in page
    iconUrl: '/favicon.svg',   // http(s) URL, root-relative path or base64 data:image URL
    cliName: 'RateBell CLI',   // the terminal's welcome banner
});
```

Anything left unset keeps the Qodalis default. The terminal's copyright line, docs link and `version` stay Qodalis
CLI's. The values are served with the color scheme at `/qcli/admin/theme.json`; `setBranding()` throws on an
invalid value.

## Terminal commands

The plugin brings the `admin` command (registered by `mountPlugin`). It reads the same services as the admin routes.
On a protected server every sub-command needs `admin:access`; `admin logs` also needs `logs:read`, `admin dashboard
install|update|remove` also `dashboard:install`, `admin plugins install|update|remove` `plugins:install`, `admin restart` (but not `admin restart status`) `server:restart`. Server settings are
the core [`config`](../../README.md#terminal-commands) command; a dashboard plugin's settings are changed after its install with
`config set dashboard-plugins.<id>.<key> <value>` (`config:write`). Lists take `--json` (the payload of the matching route).

| Command | Permission | Does |
|---|---|---|
| `admin`, `admin status [--json]` | `admin:access` | Server package and version, platform, uptime, memory, CPU, connections, commands, jobs, features (`GET /status`) |
| `admin status --history [--minutes 60] [--json]` | `admin:access` | Summary of the status samples of the last minutes (1-1440): count, min/avg/max memory and CPU, peak connections (`GET /status/history`) |
| `admin plugins`, `admin plugins list [--json]` | `admin:access` | Command modules: id, name, version, enabled or disabled, commands (`GET /plugins`) |
| `admin plugins enable <id>`, `admin plugins disable <id>` | `admin:access` | Turns a module's commands on or off, like `POST /plugins/{id}/toggle` but idempotent (`... is already enabled.`); the `admin` module itself cannot be disabled from the terminal |
| `admin plugins search [<query>] [--json]` | `admin:access` | The marketplace's server plugins: plugin, this server's package, version, platforms, publisher, installed / installable / blocked and why (`GET /server/marketplace/plugins`) |
| `admin plugins installed [--json]` | `admin:access` | The server plugins installed from the marketplace: package, version (update available), status (loaded, pending restart, failed with its error, removed), when and by whom |
| `admin plugins install <name>[@version]` | `admin:access`, `plugins:install` | Installs this server's package of a server plugin with the API's checks; it runs after a restart (`POST /server/marketplace/installed`) |
| `admin plugins update <name>[@version]` | `admin:access`, `plugins:install` | Updates to the newest compatible version or the one given (`PUT /server/marketplace/installed/{name}`) |
| `admin plugins remove <name>` | `admin:access`, `plugins:install` | Uninstalls it; it runs until a restart (`DELETE /server/marketplace/installed/{name}`) |
| `admin clients [--json]` | `admin:access` | Connected WebSocket clients: id, type, connected since, address (`GET /ws/clients`) |
| `admin logs [--level warn,error] [--search <text>] [--service <source>] [--since 5m\|1h\|7d\|<ISO date>] [-n 50] [--json]` | `admin:access`, `logs:read` | The newest matching log entries (1-1000), oldest first, from the log buffer (`GET /logs`) |
| `admin dashboard`, `admin dashboard list [--json]` | `admin:access` | The dashboard plugins installed from the marketplace: page id, package, version (and whether an update is available), when and by whom (`GET /dashboard/marketplace/installed`) |
| `admin dashboard search [<query>] [--json]` | `admin:access` | The marketplace's dashboard plugins: package, version, publisher, installed / installable / blocked and why, a missing server plugin (`GET /dashboard/marketplace/plugins`) |
| `admin dashboard info <name> [--json]` | `admin:access` | An installed plugin: page, files, and its settings with their values, defaults and rules (`*` marks a changed value) |
| `admin dashboard install <name>[@version] [--config '<json>']` | `admin:access`, `dashboard:install` | Installs the newest version this dashboard runs, or the one given, with values for its settings, with the API's checks (`POST /dashboard/marketplace/installed`) |
| `admin dashboard update <name> [--config '<json>']` | `admin:access`, `dashboard:install` | Updates to the newest version, reporting the settings it drops (`PUT /dashboard/marketplace/installed/{name}`) |
| `admin dashboard remove <name>` | `admin:access`, `dashboard:install` | Removes the page and its files (`DELETE /dashboard/marketplace/installed/{name}`) |
| `admin restart [--yes] [--reason <text>]` | `admin:access`, `server:restart` | Without `--yes` (server commands cannot ask): the changes waiting for a restart and how to confirm; with it, restarts the server like `POST /server/restart` (audited with `via: command`) |
| `admin restart status [--json]` | `admin:access` | Start time, restart mode and supervisor (or why it cannot restart), the pending changes (`GET /server/restart`) |

On a server without the users plugin, `/execute` is open, and so are these commands. To follow the log live, use
`server logs` of the web CLI plugin `@qodalis/cli-server-logs` (the `/ws/v1/qcli/logs` socket, `logs:read`).

```text
$ admin status
Server      @qodalis/cli-server-node 1.0.0-beta.31
Platform    node v22.12.0 (linux)
Uptime      2 h 5 min (since 2026-11-25 08:00:00)
Memory      84.2 MB (process) · machine 9.8 GB of 16 GB used (61%)
CPU         1.3%
Connections 2 WebSocket, 0 shell
Commands    41
Jobs        1
Features    filesystem, jobs, audit

$ admin status --history --minutes 15
Last 15 min: 60 sample(s) every 15 s, 2026-11-25 09:50:00 to 2026-11-25 10:04:45
Memory      min 80.1 MB  avg 82.4 MB  max 85.3 MB
CPU         min 0.2%  avg 1.1%  max 5.4%
Peak        3 WebSocket, 1 shell

$ admin plugins
ID         Name       Version  Status    Commands
weather    weather    1.0.0    enabled   1
databases  databases  1.0.0    enabled   1
admin      admin      1.0.0    enabled   1

$ admin plugins disable weather
Disabled weather (1 command).

$ admin logs --level warn,error -n 2
Last 2 of 7 entries
2026-11-25 10:01:12 WARN  [jobs] cleanup took 12 s
2026-11-25 10:03:40 ERROR [db] connection timeout

$ admin dashboard search
Package                             Version  Publisher            Status
@qodalis/cli-dashboard-module-jobs  1.1.0    @qodalis (verified)  installable
@acme/cli-dashboard-tickets         2.0.0    @acme                blocked: unverified publisher

$ admin dashboard install @qodalis/cli-dashboard-module-jobs@1.0.0
Installed @qodalis/cli-dashboard-module-jobs@1.0.0: the dashboard page "Jobs" (/x/jobs).

$ admin dashboard
1 dashboard plugin(s) from https://plugins.qodalis.com (install: verified)
ID    Package                             Version                   Installed            By
jobs  @qodalis/cli-dashboard-module-jobs  1.0.0 (update available)  2026-11-25 10:04:05  admin

$ admin dashboard update @qodalis/cli-dashboard-module-jobs
Updated @qodalis/cli-dashboard-module-jobs from 1.0.0 to 1.1.0.

$ admin dashboard install @acme/cli-dashboard-tickets --config '{"refreshSeconds":1,"mode":"huge"}'
Error: validation failed
  refreshSeconds: must be at least 5
  mode: must be one of: compact, full

$ admin dashboard install @acme/cli-dashboard-tickets --config '{"refreshSeconds":60}'
Installed @acme/cli-dashboard-tickets@1.0.0: the dashboard page "Tickets" (/x/tickets).
Its settings: admin dashboard info @acme/cli-dashboard-tickets

$ admin dashboard info @acme/cli-dashboard-tickets
@acme/cli-dashboard-tickets@1.0.0
  Page        Tickets (/x/tickets)
  Installed   2026-11-25 10:04:05 by admin
  Files       extension.js (48211 bytes), extension.css (5120 bytes)
Settings (config set dashboard-plugins.tickets.<key> <value>; version 1):
Key             Value              Type      Default            Rule
refreshSeconds  60 *               number    30                 min 5; max 3600
columns         ["name","status"]  string[]  ["name","status"]  -
mode            compact            enum      compact            one of compact, full
* changed from the default

$ config set dashboard-plugins.tickets.mode full
Updated dashboard-plugins.tickets.mode = full (version 2)

$ admin dashboard update @acme/cli-dashboard-tickets --config '{"theme":"dark"}'
Updated @acme/cli-dashboard-tickets from 1.0.0 to 2.0.0.
Settings dropped (the new version no longer accepts them): refreshSeconds, mode
Its settings: admin dashboard info @acme/cli-dashboard-tickets

$ admin dashboard remove @qodalis/cli-dashboard-module-jobs
Removed @qodalis/cli-dashboard-module-jobs@1.1.0 (the page jobs).

$ admin dashboard install @acme/cli-dashboard-tickets
Error: publisher not verified

$ admin restart
1 change(s) take effect after a restart:
  - CORS: Mode changed (config, since 2026-11-25 10:04:05)
Restart mode: self (starts itself again)
Run admin restart --yes [--reason "<why>"] to restart the server now.

$ admin restart --yes --reason "apply CORS"
Restarting the server to apply 1 pending change(s) (self mode). The connection drops and comes back once it runs again.

$ admin restart status
Running since 2026-11-25 10:06:12
Restart mode: exit (exits for docker to start it again)
No changes are waiting for a restart.
```

Server plugins (the restart between the two `admin plugins installed`):

```text
$ admin plugins search
Plugin   Package                             Version        Platforms             Publisher           Status
weather  @qodalis/cli-server-plugin-weather  1.0.0-beta.31  node, python, dotnet  qodalis (verified)  installable
users    @qodalis/cli-server-plugin-users    1.0.0-beta.31  node, python, dotnet  qodalis (verified)  installable
kanban   @acme/cli-server-plugin-kanban      0.1.0          node                  qodalis             blocked: unverified publisher

$ admin plugins install weather@1.0.0-beta.30
Installed weather: @qodalis/cli-server-plugin-weather@1.0.0-beta.30.
Restart the server to apply it: admin restart (or the dashboard).

$ admin plugins install admin
Error: needs setup in code: hosts the dashboard and the marketplace itself: mount it in code (CliAdminBuilder)

$ admin plugins installed
1 server plugin(s) from https://plugins.qodalis.com (install: verified)
Plugin   Package                             Version                           Status           Installed            By
weather  @qodalis/cli-server-plugin-weather  1.0.0-beta.30 (update available)  pending restart  2026-11-25 21:42:49  anonymous

$ admin plugins installed
1 server plugin(s) from https://plugins.qodalis.com (install: verified)
Plugin   Package                             Version                           Status  Installed            By
weather  @qodalis/cli-server-plugin-weather  1.0.0-beta.30 (update available)  loaded  2026-11-25 21:42:49  anonymous

$ admin plugins update weather
Updated weather from 1.0.0-beta.30 to 1.0.0-beta.31.
Restart the server to apply it: admin restart (or the dashboard).

$ admin plugins remove weather
Removed weather (@qodalis/cli-server-plugin-weather@1.0.0-beta.31).
Restart the server to apply it: admin restart (or the dashboard).
```

The list does not know yet that a plugin needs setup in code (the marketplace does not index `autoInstall`): the
install reads it from the package's npm record before anything is downloaded, and `GET /plugins/{name}` shows it.

## Install from the dashboard

Not installable at runtime: its package declares `"autoInstall": false` (it hosts the dashboard and the marketplace itself: mount it in code with `CliAdminBuilder`), so the marketplace and the
dashboard list it with "needs setup in code" and `admin plugins install admin` refuses it. Set it up in code as shown
above.

## License

MIT
