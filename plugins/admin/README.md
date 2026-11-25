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
- `logs`: `buffer.capacity` (entries kept, 100-100000) and `buffer.minLevel` (`DEBUG`, `INFO`, `WARN`, `ERROR`), changed at runtime.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/config` | `{ store, providers: [...] }`: where changes are saved (`{ kind, title, detail, persistent }`) and the providers the caller may see (`config:read`), each with its `storage`, secrets masked |
| GET | `/config/{provider}` | One provider (404 unknown, 403 without its `requiredPermission`) |
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
On a protected server every sub-command needs `admin:access`; `admin logs` also needs `logs:read`. Server settings are
the core [`config`](../../README.md#terminal-commands) command. Lists take `--json` (the payload of the matching route).

| Command | Permission | Does |
|---|---|---|
| `admin`, `admin status [--json]` | `admin:access` | Server package and version, platform, uptime, memory, CPU, connections, commands, jobs, features (`GET /status`) |
| `admin status --history [--minutes 60] [--json]` | `admin:access` | Summary of the status samples of the last minutes (1-1440): count, min/avg/max memory and CPU, peak connections (`GET /status/history`) |
| `admin plugins`, `admin plugins list [--json]` | `admin:access` | Command modules: id, name, version, enabled or disabled, commands (`GET /plugins`) |
| `admin plugins enable <id>`, `admin plugins disable <id>` | `admin:access` | Turns a module's commands on or off, like `POST /plugins/{id}/toggle` but idempotent (`... is already enabled.`); the `admin` module itself cannot be disabled from the terminal |
| `admin clients [--json]` | `admin:access` | Connected WebSocket clients: id, type, connected since, address (`GET /ws/clients`) |
| `admin logs [--level warn,error] [--search <text>] [--service <source>] [--since 5m\|1h\|7d\|<ISO date>] [-n 50] [--json]` | `admin:access`, `logs:read` | The newest matching log entries (1-1000), oldest first, from the log buffer (`GET /logs`) |

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
```

## License

MIT
