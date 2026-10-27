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
| `setRegisteredJobs(count)` | Report job count in the status endpoint |
| `setEnabledFeatures(features)` | Add custom feature flags to the status endpoint |
| `setDashboardDir(dir)` | Override the path to the dashboard SPA dist directory |

## REST API

All endpoints are mounted at the plugin's built-in prefix (`/api/v1/qcli`). Routes below `/auth/login` require a valid JWT in the `Authorization: Bearer <token>` header.

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/login` | Authenticate with username/password, receive JWT |
| GET | `/auth/me` | Get current user info from token |

### Status

| Method | Endpoint | Description |
|---|---|---|
| GET | `/status` | Server uptime, memory, platform, connections, registered commands, enabled features |

### Plugins

| Method | Endpoint | Description |
|---|---|---|
| GET | `/plugins` | List all registered modules |
| POST | `/plugins/:id/toggle` | Enable or disable a module |

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

## Dashboard

The plugin includes a bundled SPA dashboard served at the built-in prefix (`/qcli/admin`). The dashboard is found in this order: the directory given to `setDashboardDir()`, a sibling `cli-server-dashboard/dist` build (development), the package's bundled `dashboard/` directory, and the `@qodalis/cli-server-dashboard` package if installed separately. The same order applies whether the plugin runs compiled or from source (`tsx`).

## License

MIT
