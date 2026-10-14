# @qodalis/cli-server-plugin-users

User management plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Adds REST endpoints for authentication, users, sessions, groups and an audit log, backed by swappable storage interfaces with in-memory defaults. It is the server side of the `@qodalis/cli-users` plugin's *server mode*.

## Install

```bash
npm install @qodalis/cli-server-plugin-users
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { buildUsersPlugin } from '@qodalis/cli-server-plugin-users';

const { app, eventSocketManager, mountPlugin } = createCliServer({ /* ... */ });

const usersPlugin = await buildUsersPlugin(
    { defaultAdminPassword: 'admin' },
    // Optional: relay session events (e.g. `session-kicked`) over the events WebSocket
    (msg) => eventSocketManager.broadcastMessage(msg),
);

// Mounts the router at usersPlugin.prefix (/api/v1/qcli)
mountPlugin(usersPlugin);
// or: app.use(usersPlugin.prefix, usersPlugin.router);

// On shutdown
usersPlugin.dispose();
```

On first start the plugin seeds a `root` admin user (email `root@localhost`, password from `defaultAdminPassword`, default `root`) and an `admin` group, unless an external auth adapter is configured.

## Options

`buildUsersPlugin(options?, broadcastEvent?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `userStore` | `ICliUserStore` | `InMemoryUserStore` | User storage |
| `sessionStore` | `ICliSessionStore` | `InMemorySessionStore` | Session/token storage |
| `credentialStore` | `ICliCredentialStore` | `InMemoryCredentialStore` | Password hash storage |
| `auditStore` | `ICliAuditStore` | `InMemoryAuditStore` | Audit log storage |
| `groupStore` | `ICliGroupStore` | `InMemoryGroupStore` | Group storage |
| `sessionTimeoutMs` | `number` | `1800000` (30 min) | Idle timeout; expired sessions are purged every 5 minutes |
| `defaultAdminPassword` | `string` | `'root'` | Password for the seeded `root` user |
| `authAdapter` | `AuthAdapter` | — | Delegate authentication to the host app (see below) |

The result exposes `prefix`, `router`, `authService`, `userStore`, `sessionStore`, `groupStore`, `auditStore` and `dispose()`.

## API Endpoints

All routes are mounted under `/api/v1/qcli`. Protected routes expect `Authorization: Bearer <token>`.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/sessions` | POST | None | Login: `{ username, password }` → `201 { token, session }` |
| `/sessions/current` | DELETE | Required | Logout: end the current session (204) |
| `/users` | GET | Required | List users (`?query=&skip=&take=`) |
| `/users/:idOrName` | GET | Required | Get a user |
| `/users` | POST | Admin | Create a user `{ name, email, password?, groups?, data? }` |
| `/users/:id` | PUT | Admin | Update a user |
| `/users/:id` | DELETE | Admin | Delete a user and its sessions/credentials (204) |
| `/users/:id/password` | PUT | Self or admin | `{ currentPassword?, newPassword }`; a wrong current password returns 403 |
| `/users/:id/verify-password` | POST | Required | `{ password }` → `{ valid }` |
| `/sessions` | GET | Admin | List active sessions |
| `/sessions/current` | GET | Required | Current session |
| `/sessions/:id` | DELETE | Admin | Kick a session (204) and broadcast `session-kicked` |
| `/groups` | GET | Required | List groups |
| `/groups/:name` | GET | Required | Get a group |
| `/groups` | POST | Admin | Create a group `{ name, description? }` |
| `/groups/:name` | DELETE | Admin | Delete a group (204) |
| `/groups/:name/members/:userId` | PUT | Admin | Add a user to a group (204) |
| `/groups/:name/members/:userId` | DELETE | Admin | Remove a user from a group (204) |
| `/audit` | GET | Admin | Audit entries (`?event=&username=&limit=`) |
| `/audit` | DELETE | Admin | Clear the audit log (204) |

The admin dashboard plugin keeps its own login at `/auth/login`; both plugins can be mounted at the same prefix.

Tokens are opaque random strings validated against the session store on every request; `lastActivity` is refreshed on each authenticated call.

## Session kick event

`DELETE /sessions/:id` calls the `broadcastEvent` callback with:

```json
{ "type": "session-kicked", "data": { "sessionId": "...", "userId": "..." } }
```

When relayed over the events WebSocket, a `@qodalis/cli-users` client in server mode logs itself out when its own session id is kicked.

## Custom storage

Implement any of the interfaces exported from the package (`ICliUserStore`, `ICliSessionStore`, `ICliCredentialStore`, `ICliAuditStore`, `ICliGroupStore`) and pass the instance in the options:

```typescript
const usersPlugin = await buildUsersPlugin({
    userStore: new PostgresUserStore(pool),
    sessionStore: new RedisSessionStore(redis),
});
```

## External auth adapter

If the host application already authenticates requests, pass an `authAdapter`. It receives the Express request (after your own auth middleware) and returns the CLI user plus an admin flag, or `null`/`undefined` when unauthenticated. Login (`POST /sessions`), logout (`DELETE /sessions/current`) and `verify-password` then answer `501`, and no `root` user is seeded.

```typescript
const usersPlugin = await buildUsersPlugin({
    authAdapter: (req) => {
        const principal = (req as any).user; // set by your middleware
        return principal
            ? { user: toCliUser(principal), isAdmin: principal.roles.includes('admin') }
            : null;
    },
});
```

## Client

Point the browser plugin at this server:

```typescript
import { usersModule } from '@qodalis/cli-users';

engine.registerModule(usersModule.configure({ server: 'node' }));
// options.servers must contain { name: 'node', url: 'http://localhost:8047' }
```

The client then logs in through `POST /sessions`, attaches the bearer token to every request to that server, and gains the `sessions` and `session-kick` commands.

## License

MIT
