# @qodalis/cli-server-plugin-users

User management plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Adds REST endpoints for authentication, users, groups with permissions, sessions and an audit log, backed by swappable storage interfaces with in-memory defaults. It is the server side of the `@qodalis/cli-users` plugin's *server mode* and implements the same contract as the .NET and Python servers.

## Install

```bash
npm install @qodalis/cli-server-plugin-users
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';

const { eventSocketManager, mountPlugin } = createCliServer({ /* ... */ });

const usersPlugin = new CliUsersBuilder()
    .setDefaultAdminPassword('admin')
    .setSessionTimeout(30 * 60 * 1000)
    // Relays `session-kicked` events over the events WebSocket
    .build((msg) => eventSocketManager.broadcastMessage(msg));

mountPlugin(usersPlugin);      // mounted at usersPlugin.prefix (/api/v1/qcli)
await usersPlugin.ready;       // optional: seeding done (requests wait for it anyway)

// On shutdown
usersPlugin.dispose();
```

`build()` is synchronous; seeding runs in the background and is exposed as `ready`. Seeding creates the built-in groups `admin` (`["*"]`) and `users` (`[]`) when missing and, unless an auth adapter is configured and the user store is empty, a `root` user (`root@localhost`, group `admin`, password from `setDefaultAdminPassword`, default `root`).

`buildUsersPlugin(options, broadcastFn)` is still exported as a **deprecated** async wrapper around the builder.

## Builder

| Method | Default | Description |
|--------|---------|-------------|
| `setDefaultAdminPassword(pw)` | `'root'` | Password of the seeded `root` user |
| `setUserStore(store)` / `setSessionStore` / `setCredentialStore` / `setAuditStore` / `setGroupStore` | in-memory | Custom storage |
| `setAuthAdapter(fn)` | — | Delegate authentication to the host app (see below) |
| `setSessionTimeout(ms)` | 30 min | Idle timeout; checked on every request, `lastActivity` slides |
| `setMaxLoginAttempts(n)` | 5 | Consecutive failures before lockout |
| `setLockoutDuration(ms)` | 5 min | Lockout duration |
| `setMinPasswordLength(n)` | 4 | Password policy |
| `setCleanupInterval(ms)` | 5 min | Background sweep of expired sessions |
| `setOptions(options)` | — | Same options as a plain object |

The result exposes `prefix`, `router`, `ready`, `authService`, `directory`, the five stores and `dispose()`.

## Permissions

Groups carry `permissions` (`resource:action`, `*` wildcards, case-insensitive — same semantics as `cliPermissionMatches` in `@qodalis/cli-core`). A user's effective permissions are the union of their groups' permissions; group names are case-insensitive. Built-in permissions: `users:read|create|update|delete`, `groups:read|create|update|delete`, `sessions:read|revoke`, `audit:read|clear`.

The session references the user by id; the **live** user and permissions are resolved on every request, so group/disabled changes apply immediately.

## API Endpoints

Mounted under `/api/v1/qcli`; protected routes expect `Authorization: Bearer <token>`. Paths work with and without a trailing slash. Errors are always `{ "error": "<message>" }`. Missing/invalid auth → 401, missing permission → 403.

| Endpoint | Requirement | Notes |
|----------|-------------|-------|
| `POST /sessions` | public | Login `{ username, password }` (name or email) → `201 { token, session }`; disabled → 403, locked → 429 |
| `GET /sessions/current` | authenticated | `{ id, user, permissions, loginTime, lastActivity, expiresAt }` |
| `DELETE /sessions/current` | authenticated | Logout (204) |
| `GET /sessions` | `sessions:read` | Sessions (never tokens), `current` flag |
| `DELETE /sessions/:id` | `sessions:revoke` or own session | 204, broadcasts `session-kicked` |
| `GET /users` | `users:read` | `?query=&skip=&take=` |
| `GET /users/:idOrName` | `users:read` or self | |
| `GET /users/:idOrName/permissions` | `users:read` or self | `{ userId, groups, permissions }` |
| `POST /users` | `users:create` | `{ name, email, groups?, password?, disabled?, homeDir?, data? }` → 201 |
| `PUT /users/:idOrName` | `users:update`; self: `email`, `data` only | → 200 |
| `DELETE /users/:idOrName` | `users:delete` | 204 |
| `PUT /users/:idOrName/password` | self (with `currentPassword`) or `users:update` | `{ password, currentPassword? }` → 204 |
| `POST /users/:idOrName/verify-password` | self or `users:update` | `{ password }` → `{ valid }`; failures count toward lockout |
| `GET /groups`, `GET /groups/:name` | authenticated | |
| `GET /groups/:name/members` | `groups:read` or member | `User[]` |
| `POST /groups` | `groups:create` | `{ name, description?, permissions? }` → 201 |
| `PUT /groups/:name` | `groups:update` | `{ description?, permissions? }`; `admin` permissions → 409 |
| `DELETE /groups/:name` | `groups:delete` | built-in → 409 |
| `POST /groups/:name/members/:idOrName` | `groups:update` | 204 (`PUT` accepted as a legacy alias) |
| `DELETE /groups/:name/members/:idOrName` | `groups:update` | 204 |
| `GET /audit` | `audit:read` | `?limit=&event=&username=`, newest first |
| `DELETE /audit` | `audit:clear` | 204 |

### Protections and cascades

- Duplicate user name/email or group → 409; unknown referenced group → 400 `unknown group: x`.
- You cannot delete yourself; the last enabled member of `admin` cannot be deleted, disabled or removed from `admin` (409).
- Deleting a group removes it from every user. Deleting a user deletes its credentials and revokes its sessions. Disabling a user revokes its sessions. A password change by the user revokes their other sessions; by someone else, all of the target's sessions.
- Every revoked session is broadcast as `{ "type": "session-kicked", "data": { "sessionId", "userId", "reason" } }`.

### Credentials

Passwords are hashed with PBKDF2-HMAC-SHA256 (100,000 iterations, 16-byte salt, 32-byte key), stored as `pbkdf2$100000$<saltB64>$<hashB64>` and compared in constant time. After 5 consecutive failures an account is locked for 5 minutes (`429 { "error": "account locked, try again later" }`).

### Audit events

`login`, `login_failed`, `logout`, `user_created`, `user_updated`, `user_deleted`, `user_disabled`, `user_enabled`, `password_changed`, `group_created`, `group_updated`, `group_deleted`, `group_member_added`, `group_member_removed`, `session_revoked`, `audit_cleared` — with `actor` set to the acting user. The in-memory store keeps the last 1000 entries.

## Custom storage

Implement any of `ICliUserStore`, `ICliSessionStore`, `ICliCredentialStore`, `ICliAuditStore`, `ICliGroupStore` and pass it to the builder:

```typescript
const usersPlugin = new CliUsersBuilder()
    .setUserStore(new PostgresUserStore(pool))
    .setSessionStore(new RedisSessionStore(redis))
    .build(broadcast);
```

## External auth adapter

If the host application already authenticates requests, pass an adapter. It receives the Express request and returns the CLI user plus an admin flag, or `null` when unauthenticated. The user is resolved per request; login, logout, verify-password and password endpoints answer `501`; no `root` user is seeded (built-in groups still are); adapter sessions are not stored or listed.

```typescript
const usersPlugin = new CliUsersBuilder()
    .setAuthAdapter((req) => {
        const principal = (req as any).user; // set by your middleware
        return principal ? { user: toCliUser(principal), isAdmin: principal.roles.includes('admin') } : null;
    })
    .build(broadcast);
```

The admin dashboard plugin keeps its own login at `/auth/login`; both plugins can be mounted at the same prefix.

## License

MIT
