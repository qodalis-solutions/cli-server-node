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

app.use('/api/v1/qcli', adminPlugin.router);
app.use('/qcli/admin', adminPlugin.dashboardRouter);
```

## Configuration

Credentials and JWT secret can be set via the builder or environment variables:

| Environment Variable | Default | Description |
|---|---|---|
| `QCLI_ADMIN_USERNAME` | `admin` | Admin login username |
| `QCLI_ADMIN_PASSWORD` | `admin` | Admin login password |
| `QCLI_ADMIN_JWT_SECRET` | Random | JWT signing secret |

## Builder Options

| Method | Description |
|---|---|
| `setCredentials(username, password)` | Set admin login credentials |
| `setJwtSecret(secret)` | Set JWT signing secret |
| `setRegisteredJobs(count)` | Report job count in the status endpoint |
| `setEnabledFeatures(features)` | Add custom feature flags to the status endpoint |
| `setDashboardDir(dir)` | Override the path to the dashboard SPA dist directory |

## REST API

All endpoints are mounted at the path you choose (typically `/api/v1/qcli`). Routes below `/auth/login` require a valid JWT in the `Authorization: Bearer <token>` header.

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

| Method | Endpoint | Description |
|---|---|---|
| GET | `/config` | Return structured config sections (server, auth, custom) |
| PUT | `/config` | Update mutable (custom) settings |

### Logs

| Method | Endpoint | Description |
|---|---|---|
| GET | `/logs` | Query log entries with optional `level`, `search`, `limit`, `offset` params |

### WebSocket Clients

| Method | Endpoint | Description |
|---|---|---|
| GET | `/ws/clients` | List connected WebSocket clients |

## Dashboard

The plugin includes a bundled SPA dashboard served at the mount path you choose (e.g. `/qcli/admin`). The dashboard auto-resolves from the package's `dashboard/` directory, or from the `@qodalis/cli-server-dashboard` package if installed separately.

## License

MIT
