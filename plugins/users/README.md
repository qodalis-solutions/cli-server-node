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

Mounting the plugin protects the **whole** CLI server by default (`protectServer`): every `/api/...` route and WebSocket then requires a users session — see *Server protection* below.

`build()` is synchronous; seeding runs in the background and is exposed as `ready`. Seeding creates the built-in groups `admin` (`["*"]`) and `users` (`["commands:execute"]`) when missing and, unless an auth adapter is configured, a `root` user (`root@localhost`, group `admin`) when the user store is empty. Without `setDefaultAdminPassword` a random 16-character password is generated, logged once with a warning, and root must change it at first login (`mustChangePassword`). An explicit well-known password (`root`, `admin`, `password`) logs a warning.

`buildUsersPlugin(options, broadcastFn)` is still exported as a **deprecated** async wrapper around the builder.

## Builder

| Method | Default | Description |
|--------|---------|-------------|
| `setDefaultAdminPassword(pw)` | `'root'` | Password of the seeded `root` user |
| `setUserStore(store)` / `setSessionStore` / `setCredentialStore` / `setAuditStore` / `setGroupStore` | in-memory | Custom storage |
| `setAuthAdapter(fn)` | — | Delegate authentication to the host app (see below) |
| `setSessionTimeout(ms)` | 30 min | Idle timeout; checked on every request, `lastActivity` slides |
| `setMaxLoginAttempts(n)` | 5 | Consecutive failures before lockout (each within the lockout duration of the previous one; an older count resets) |
| `setLockoutDuration(ms)` | 5 min | Lockout duration, and how long a failure count below the threshold is remembered |
| `setMinPasswordLength(n)` | 8 | Password policy (max length is always 1024) |
| `setMaxSessionLifetime(ms)` | 12 h | Absolute session lifetime; `expiresAt` = min(idle, absolute) |
| `setProtectServer(bool)` | `true` | Protect every server route and socket when mounted |
| `setAllowedOrigins(list)` | server's | Origins accepted for adapter/cookie-mode state changes (CSRF) |
| `setTrustProxy(bool \| hops)` | `false` | Trusted proxy hops (`true` = 1): client IP = `X-Forwarded-For` entry at index `len - hops` (rightmost with one hop) |
| `setIpRateLimit(max, windowMs)` | 20 / min | Per-IP limit on login, verify-password and self password change |
| `setCleanupInterval(ms)` | 5 min | Background sweep of expired sessions |
| `setOptions(options)` | — | Same options as a plain object |

The result exposes `prefix`, `router`, `ready`, `authService`, `directory`, the five stores, `serverAuth` (the server/admin auth provider), `requireAuth()`, `requirePermission(...perms)` and `dispose()`.

## Server protection

`mountPlugin(usersPlugin)` (or `createCliServer({ auth: usersPlugin.serverAuth })`) protects every CLI server route and socket. Public: `POST /api/v1/qcli/sessions`, version discovery and capabilities.

| Surface | Permission |
|---|---|
| `GET /commands` | authenticated |
| `POST /execute`, `/execute/stream` | `commands:execute` + the processor's `requiredPermissions` |
| fs read / write | `files:read` / `files:write` |
| data explorer | `data:query` |
| jobs read / manage | `jobs:read` / `jobs:manage` |
| events / logs / shell WebSocket | authenticated / `logs:read` / `shell:execute` (an open shell is closed with 4401 when its session ends or loses `shell:execute`) |
| admin dashboard (`setAuthProvider`) | `admin:access` |

WebSockets take a single-use ticket: `POST /sessions/ws-ticket` → `201 { ticket, expiresIn: 30 }`, then `?ticket=<ticket>` on the upgrade URL (bound to the session, 30 s, consumed on first use). Bearer tokens are not accepted in WS query strings. `session-kicked` is sent only to sockets of the affected user. Host routes can use `usersPlugin.requireAuth()` / `usersPlugin.requirePermission('deploy:run')`.

While a user has `mustChangePassword`, only `GET/DELETE /sessions/current` and `PUT /users/{self}/password` work; everything else answers `403 { "error": "password change required" }`.

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
| `POST /sessions/ws-ticket` | authenticated | `201 { ticket, expiresIn: 30 }` |
| `POST /groups` | `groups:create` | `{ name, description?, permissions? }` → 201 |
| `PUT /groups/:name` | `groups:update` | `{ description?, permissions? }`; `admin` permissions → 409 |
| `DELETE /groups/:name` | `groups:delete` | built-in → 409 |
| `POST /groups/:name/members/:idOrName` | `groups:update` | 204 (`PUT` accepted as a legacy alias) |
| `DELETE /groups/:name/members/:idOrName` | `groups:update` | 204 |
| `GET /audit` | `audit:read` | `?limit=&event=&username=`, newest first |
| `DELETE /audit` | `audit:clear` | 204 |

### Protections and cascades

- Duplicate user name/email (one shared namespace) or group → 409; unknown referenced group → 400 `unknown group: x`.
- No privilege escalation: granting permissions, adding to groups, or acting on a user (name/groups/disabled, password reset, delete, session revoke) requires holding every permission involved; otherwise 403 (`cannot grant permissions you do not hold: …` / `insufficient privileges for this user`).
- Validation (400): names 1–64 `[A-Za-z0-9][A-Za-z0-9._@-]*`, email `local@domain` ≤ 254, permissions ≤ 128 chars (≤ 100 per group), description ≤ 256, `data` ≤ 16 KB, no control characters; request bodies ≤ 1 MB.
- An admin password reset makes the password temporary (`mustChangePassword`) unless the body has `"temporary": false`, and clears the target's lockout.
- You cannot delete yourself; the last enabled member of `admin` cannot be deleted, disabled or removed from `admin` (409).
- Deleting a group removes it from every user. Deleting a user deletes its credentials and revokes its sessions. Disabling a user revokes its sessions. A password change by the user revokes their other sessions; by someone else, all of the target's sessions.
- Every revoked session is broadcast as `{ "type": "session-kicked", "data": { "sessionId", "userId", "reason" } }`.

### Credentials

Passwords are hashed with PBKDF2-HMAC-SHA256 (100,000 iterations, 16-byte salt, 32-byte key, at most 4 concurrent hashes), stored as `pbkdf2$100000$<saltB64>$<hashB64>` and compared in constant time. After 5 consecutive failures an account is locked for 5 minutes (`429 { "error": "account locked, try again later" }`); attempts are reserved before hashing so concurrent requests cannot exceed the limit, and unknown usernames are tracked and locked the same way (with a dummy hash for equal timing). Session stores only keep `SHA-256(token)`.

In adapter/cookie mode, state-changing requests without a bearer header must come from an `Origin` in `allowedOrigins` or from the server's own origin (same-origin, e.g. the bundled admin dashboard) (CSRF), otherwise 403.

### Audit events

Entries carry `userId` / `actorId` when known. `login_failed` entries are capped separately (last 200).

`login`, `login_failed`, `logout`, `user_created`, `user_updated`, `user_deleted`, `user_disabled`, `user_enabled`, `password_changed`, `group_created`, `group_updated`, `group_deleted`, `group_member_added`, `group_member_removed`, `session_revoked`, `audit_cleared`, `shell_opened`, `shell_closed` (written by the CLI server's shell; `metadata: { mode, sessionId, durationMs, reason, exitCode? }`, never the command text) — with `actor` set to the acting user. The in-memory store keeps the last 1000 entries.

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

**Remote shell.** A shell opened by an adapter-authenticated user has no stored session to re-check. Instead, every periodic/event re-check (and one right after the shell opens) calls the adapter again with the shell socket's original HTTP **upgrade request** (a raw Node `IncomingMessage`: headers such as `Cookie`/`Authorization`, URL, socket — no Express middleware has run on it, so e.g. `req.user` is not set). Returning `null`/`undefined`, throwing, or returning a different user closes the shell with 4401 `session ended`; a user that no longer holds `shell:execute` (after the `isAdmin` → `admin` group mapping) closes it with audit reason `permission removed`. Make sure the adapter can authenticate the upgrade request on its own (e.g. from the session cookie the browser sends with the WebSocket handshake).

The admin dashboard plugin keeps its own login at `/auth/login`; both plugins can be mounted at the same prefix.

## License

MIT
