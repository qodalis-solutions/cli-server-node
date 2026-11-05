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

const { app, registry, builder, eventSocketManager } = createCliServer({
    configure: (builder) => {
        // register your modules...
    },
});

const adminPlugin = new CliAdminBuilder()
    .setCredentials('admin', 'my-secret-password')
    .setJwtSecret('my-jwt-secret')
    .build({ registry, eventSocketManager, builder });

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
| GET | `/status` | Server uptime, memory, platform, connections, registered commands, enabled features (`filesystem`, `jobs`, `audit` with the audit plugin, which the users plugin adds) |

### Plugins

| Method | Endpoint | Description |
|---|---|---|
| GET | `/plugins` | List all registered modules |
| GET | `/plugins/installed` | The installed server plugin packages (`id`, `name`, `version`, `description`), the server (`Core`) first |
| POST | `/plugins/:id/toggle` | Enable or disable a module |

The built-in plugins list themselves when added (`mountPlugin` for users, admin and jobs; `addModule`, `setFileStorageProvider`/`addFileSystem` and `addDataExplorerProvider` for modules and providers). A plugin of your own calls `builder.addInstalledPlugin(__dirname)` (reads the nearest `package.json`) or `builder.addInstalledPlugin({ id, name, version, description })`; modules and providers can instead carry the description under `CLI_INSTALLED_PLUGIN` (`@qodalis/cli-server-abstractions`).

### Configuration

When the users plugin is installed, pass `setAuthProvider(usersPlugin.serverAuth)`: the dashboard then logs in with users credentials, its token is a users session token, and every admin route requires `admin:access`. The static credentials below are only used when the users plugin is absent.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/config` | Return structured config sections (server, auth, custom) |
| PUT | `/config` | Update mutable (custom) settings |

### Logs

| Method | Endpoint | Description |
|---|---|---|
| GET | `/logs` | Query log entries with optional `level`, `search`, `limit`, `offset` params |

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

## License

MIT
