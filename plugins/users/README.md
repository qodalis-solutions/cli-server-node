# @qodalis/cli-server-plugin-users

User management plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Adds REST endpoints for authentication, users, groups with permissions, sessions and API tokens, backed by swappable storage interfaces with in-memory defaults. It is the server side of the `@qodalis/cli-users` plugin's *server mode* and implements the same contract as the .NET and Python servers. It records its events in the [audit plugin](../audit/README.md) (`@qodalis/cli-server-plugin-audit`), which it adds and serves at `/audit`.

## Install

```bash
npm install @qodalis/cli-server-plugin-users
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';

const { mountPlugin } = createCliServer({ /* ... */ });

const usersPlugin = new CliUsersBuilder()
    .setDefaultAdminPassword('admin')
    .setSessionTimeout(30 * 60 * 1000)
    // Publishes its events (and `session-kicked`) on the server's event bus, handed over by mountPlugin
    .build();

mountPlugin(usersPlugin);      // mounted at usersPlugin.prefix (/api/v1/qcli)
await usersPlugin.ready;       // optional: seeding done (requests wait for it anyway)

// On shutdown
usersPlugin.dispose();
```

Mounting the plugin protects the **whole** CLI server by default (`protectServer`): every `/api/...` route and WebSocket then requires a users session — see *Server protection* below.

`build()` is synchronous; seeding runs in the background and is exposed as `ready`. Seeding creates the built-in groups `admin` (`["*"]`) and `users` (`["commands:execute"]`) when missing and, unless an auth adapter is configured, a `root` user (`root@localhost`, group `admin`) when the user store is empty. Without `setDefaultAdminPassword` a random 16-character password is generated and printed once to the process's stderr (written directly, not through `console`, so it never reaches the admin plugin's log buffer or the log/event sockets), and root must change it at first login (`mustChangePassword`). An explicit well-known password (`root`, `admin`, `password`) logs a warning.

## Builder

| Method | Default | Description |
|--------|---------|-------------|
| `setDefaultAdminPassword(pw)` | `'root'` | Password of the seeded `root` user |
| `setUserStore(store)` / `setSessionStore` / `setCredentialStore` / `setAuditStore` / `setGroupStore` / `setApiTokenStore` | in-memory | Custom storage (`setAuditStore`: the store of the audit plugin it adds) |
| `setAuditPlugin(plugin)` | built by the plugin | Record events in, and serve, the host's own audit plugin (`new CliAuditBuilder()...build()`) |
| `setAllowNonExpiringTokens(bool)` | `false` | Allow API tokens created with `expiresInDays: null` (never expire) |
| `setLinkApprovalUrl(url)` | `/qcli/admin/link` | The page where users approve a terminal's link request (absolute or root-relative; `{code}` is replaced, otherwise `?code=` is appended) |
| `setAuthAdapter(fn)` | — | Delegate authentication to the host app; `fn` may be sync or async (see below) |
| `setReadOnlyUsers(bool = true)` | `false` | The host owns the users: user writes answer `501` (see [Read-only stores](#read-only-stores)) |
| `setReadOnlyGroups(bool = true)` | `false` | The host owns the groups: group writes answer `501` |
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

The result exposes `prefix`, `router`, `ready`, `authService`, `directory`, the six stores (including `apiTokenStore`), `auditPlugin` (the audit plugin it records in and serves), `serverAuth` (the server/admin auth provider), `requireAuth()`, `requirePermission(...perms)` and `dispose()`.

## Events

The plugin publishes on the server's event bus (`build(eventBus)`, or the server's bus once mounted; a raw broadcast
function passed to `build()` still relays `session-kicked`, and the events then go to the server's bus when mounted):

| Type | Fields | Audience |
|---|---|---|
| `user:created`, `user:updated`, `user:deleted` | userId, username, actor | `users:read` |
| `group:created`, `group:updated`, `group:deleted` | group (its name), actor | `groups:read` |
| `token:created`, `token:revoked` | tokenId, name, userId, actor | `tokens:read` or the token's owner |
| `session:opened`, `session:closed` | userId, username, sessionId | `sessions:read` |

`user:updated` covers profile, password, enabled/disabled and group membership changes (a deleted group publishes
`user:updated` for each former member). `session:closed` covers sign-out, expiry and kicks; deleting a user publishes
`token:revoked` for each of its tokens. Events are published from the services every caller goes through, so the
REST API and a host's own calls publish alike. The audit plugin it serves publishes `audit:recorded`.

## Server protection

`mountPlugin(usersPlugin)` (or `createCliServer({ auth: usersPlugin.serverAuth })`) protects every CLI server route and socket. Public: `POST /api/v1/qcli/sessions`, version discovery and capabilities.

| Surface | Permission |
|---|---|
| `GET /commands` | authenticated |
| `POST /execute`, `/execute/stream` | `commands:execute` + the processor's `requiredPermissions` |
| fs read / write | `files:read` / `files:write` |
| data explorer | `data:query` |
| jobs read / manage | `jobs:read` / `jobs:manage` |
| audit log read / clear | `audit:read` / `audit:clear` |
| events / logs / shell WebSocket | authenticated / `logs:read` / `shell:execute` (an open shell is closed with 4401 when its session ends or loses `shell:execute`) |
| admin dashboard (`setAuthProvider`) | `admin:access` |

WebSockets take a single-use ticket: `POST /sessions/ws-ticket` → `201 { ticket, expiresIn: 30 }`, then `?ticket=<ticket>` on the upgrade URL (bound to the session, 30 s, consumed on first use). Bearer tokens are not accepted in WS query strings. `session-kicked` is sent only to sockets of the affected user. Events and logs sockets authenticated with a stored session are bound to it: when the session ends (logout, revoke/kick, user disabled or deleted, a password change becoming required, idle/absolute expiry) the socket is closed with 4401 `session ended`; for a revoke the events socket first receives `session-kicked`. Bound sockets are re-checked on every session/user/group change and after each expired-session sweep (`setCleanupInterval`, default 5 minutes). Sockets opened through an external auth adapter are re-checked through the adapter (see [External auth adapter](#external-auth-adapter)). Host routes can use `usersPlugin.requireAuth()` / `usersPlugin.requirePermission('deploy:run')`: 401/403 for auth failures (errors with a numeric `status` keep it and their message), while unexpected errors (e.g. a failing store or adapter) are logged and answered with 500 `{ "error": "internal server error" }`.

While a user has `mustChangePassword`, only `GET/DELETE /sessions/current` and `PUT /users/{self}/password` work; everything else answers `403 { "error": "password change required" }`.

## Permissions

Groups carry `permissions` (`resource:action`, `*` wildcards, case-insensitive — same semantics as `cliPermissionMatches` in `@qodalis/cli-core`). A user's effective permissions are the union of their groups' permissions; group names are case-insensitive. Built-in permissions: `users:read|create|update|delete`, `groups:read|create|update|delete`, `sessions:read|revoke`, `audit:read|clear`, `tokens:read|revoke`.

The session references the user by id; the **live** user and permissions are resolved on every request, so group/disabled changes apply immediately.

## API Endpoints

Mounted under `/api/v1/qcli`; protected routes expect `Authorization: Bearer <token>`. Paths work with and without a trailing slash. Errors are always `{ "error": "<message>" }`. Missing/invalid auth → 401, missing permission → 403.

| Endpoint | Requirement | Notes |
|----------|-------------|-------|
| `POST /sessions` | public | Login `{ username, password }` (name or email) → `201 { token, session }`; disabled → 403, locked → 429 |
| `GET /sessions/current` | authenticated | `{ id, user, permissions, loginTime, lastActivity, expiresAt, usersReadOnly, groupsReadOnly }` |
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
| `GET /tokens` | authenticated | Own API tokens; `?all=true` (requires `tokens:read`) lists every user's |
| `POST /tokens` | authenticated, **session only** | `{ name, expiresInDays?, permissions? }` → `201 { token, apiToken }` (see [API tokens](#api-tokens)) |
| `DELETE /tokens/:id` | owner or `tokens:revoke` | 204; unknown or someone else's token without `tokens:revoke` → 404 |
| `POST /link` | public, 10 per minute per address | `{ client, permissions? }` → `201 { linkId, userCode, verificationUrl, expiresIn, interval }` (see [Linking a terminal](#linking-a-terminal)) |
| `GET /link/:linkId` | public | `{ status: 'pending' \| 'denied' }`, or `{ status: 'approved', token, userName, expiresAt }` once; 404 `{ status: 'expired' }` |
| `GET /link/code/:userCode` | authenticated | The request the approval page shows |
| `POST /link/code/:userCode/approve` \| `deny` | **session only** (approve) | Approve creates the approver's API token for the terminal; deny → 204 |
| `GET /audit` | `audit:read` | The audit plugin's API: `?event=&username=&actor=&limit=&offset=`, newest first (`actor`: who did it, case-insensitive); without a `limit` the newest 100, at most 1000 |
| `DELETE /audit` | `audit:clear` | 204; records `audit_cleared` with the caller |

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

### Audit log

The audit log is the [audit plugin](../audit/README.md)'s: its entries, store and API. The users plugin adds it (`usersPlugin.auditPlugin`), serves its API at `/audit` behind the users sign-in and lists it among the installed plugins, so hosts that only add the users plugin keep their audit log. `setAuditStore(store)` sets its store; a host that builds the audit plugin itself passes it with `setAuditPlugin(auditPlugin)` (mounting it too is fine: it is the same plugin). The contract (`AuditEntry`, `AuditQueryOptions`, `ICliAuditStore`, `pruneAudit`) is in `@qodalis/cli-server-abstractions`; this package still re-exports it, with `InMemoryAuditStore` and `CliAuditBuilder`.

Entries carry `userId` / `actorId` when known. `login_failed` entries are capped separately (last 200).

`login`, `login_failed`, `logout`, `token_created`, `token_revoked` (details: token name and id), `user_created`, `user_updated`, `user_deleted`, `user_disabled`, `user_enabled`, `password_changed`, `group_created`, `group_updated`, `group_deleted`, `group_member_added`, `group_member_removed`, `session_revoked`, `audit_cleared`, `shell_opened`, `shell_closed` (written by the CLI server's shell; `metadata: { mode, sessionId, durationMs, reason, exitCode? }`, never the command text) — with `actor` set to the acting user. The group events set `target: "group:<name>"`. The host can record its own events with `authService.audit({ event, username, actor, target, properties })` (`target`: what the event is about when it is not a user; `properties`: the host's own values). The in-memory store keeps the last 1000 entries; a store may implement `prune(before)` to delete old entries (`pruneAudit(store, before)`; the in-memory store implements it).

## API tokens

API tokens are long-lived, revocable bearer tokens for MCP clients, CI and scripts (sessions expire and need a password sign-in). A token looks like `qcli_pat_` + 43 base64url characters; only its SHA-256 is stored, and it is shown **once**, when created.

```bash
# sign in, then create a token (sessions only: an API token cannot create tokens)
curl -X POST http://localhost:8047/api/v1/qcli/tokens \
     -H "Authorization: Bearer <session token>" -H "Content-Type: application/json" \
     -d '{ "name": "claude", "expiresInDays": 30, "permissions": ["commands:execute"] }'
# → 201 { "token": "qcli_pat_…", "apiToken": { "id", "name", "userId", "userName", "createdAt", "expiresAt", "lastUsedAt": null, "permissions": [...] } }
```

- `name`: 1-64 characters of `[A-Za-z0-9._ -]`, unique per user (case-insensitive; duplicate → 409).
- `expiresInDays`: integer 1-365, default 90; `null` (never expires) only with `setAllowNonExpiringTokens(true)`, otherwise 400.
- `permissions` (optional scope): valid permission strings covered by your current permissions (else `403 forbidden: cannot grant <perm>`). The token's effective permissions are your **live** permissions, narrowed to the scope entries you still hold.
- At most 20 (non-expired) tokens per user (400). Views never contain the token or its hash; `lastUsedAt` is updated at most once a minute.

`Authorization: Bearer qcli_pat_…` works wherever a session token does (server routes, the MCP endpoint, WS tickets). Unknown, revoked or expired tokens and disabled/deleted users → 401; `mustChangePassword` → 403 as for sessions. With a token, `GET`/`DELETE /sessions/current` → 404 `not a session` and password changes → `403 forbidden: API tokens cannot change passwords`. Sockets opened with a token identity close with 4401 `session ended` when the token is revoked or expires, or the user is disabled. Deleting a user deletes their tokens; disabling a user makes them fail without deleting them.

To use a token with an MCP client, see the core server's [MCP endpoint](../../README.md#mcp-endpoint):

```bash
claude mcp add --transport http qcli http://localhost:8047/api/qcli/mcp --header "Authorization: Bearer <token>"
```

## Linking a terminal

`server add` in the web CLI links a terminal to the server through the browser, like the OAuth device flow:

1. The terminal sends `POST /link` with its name (`{ "client": "Qodalis CLI on Pixel 7" }`, optionally `permissions` for a scoped token) and gets a `linkId` (secret), a code such as `ABCD-2345` and the approval page (`/qcli/admin/link?code=ABCD-2345`, the admin dashboard).
2. The user opens the page, signs in, compares the code and approves. Approving creates an API token for that user named `link <client>`, with the requested permissions (never more than the user has), listed and revocable like any token.
3. The terminal polls `GET /link/:linkId` every `interval` seconds and receives the token once.

Requests expire after 10 minutes, are single-use and live in memory. Approvals and denials are audited (`link_approved`, `link_denied`). Hosts with their own page set `setLinkApprovalUrl`.

## Custom storage

Implement any of `ICliUserStore`, `ICliSessionStore`, `ICliCredentialStore`, `ICliAuditStore` (from `@qodalis/cli-server-abstractions`), `ICliGroupStore` and pass it to the builder:

```typescript
const usersPlugin = new CliUsersBuilder()
    .setUserStore(new PostgresUserStore(pool))
    .setSessionStore(new RedisSessionStore(redis))
    .build(broadcast);
```

## External auth adapter

The middleware order and a complete setup with the admin dashboard are in [Use with your app's sign-in](../../README.md#use-with-your-apps-sign-in).

If the host application already authenticates requests, pass an adapter. It receives the Express request and returns an `ExternalAuthResult` (the CLI user, an optional admin flag and optional permissions), or `null` when unauthenticated. The user is resolved per request; login, logout, verify-password and password endpoints answer `501`; no `root` user is seeded (built-in groups still are); adapter sessions are not stored or listed. Permissions come from the groups the adapter returns (`isAdmin` adds `admin`) plus the result's `permissions`. Group names missing from the group store grant nothing (and break nothing).

```typescript
const usersPlugin = new CliUsersBuilder()
    .setAuthAdapter((req) => {
        const principal = (req as any).user; // set by your middleware
        return principal ? { user: toCliUser(principal), isAdmin: principal.roles.includes('admin') } : null;
    })
    .build(broadcast);
```

Hosts with their own roles can grant permissions directly instead of keeping a group per permission:

```typescript
return {
    user: toCliUser(account),                       // groups may be empty
    permissions: ['commands:execute', 'logs:read'], // added to the groups' permissions
};
```

The adapter may also be async (return a Promise), so it can load the user, their roles or their disabled state from a database. The plugin always awaits it: for requests, ticket issuance and every re-check of an open socket.

```typescript
const usersPlugin = new CliUsersBuilder()
    .setAuthAdapter(async (req) => {
        const account = await accounts.findBySession(req.headers.cookie);
        return account ? { user: toCliUser(account), isAdmin: account.isAdmin } : null;
    })
    .build(broadcast);
```

**Remote shell.** A shell opened by an adapter-authenticated user has no stored session to re-check. Instead, every periodic/event re-check (and one right after the shell opens) calls the adapter again on the request it accepted: the `POST /sessions/ws-ticket` request the shell's ticket was issued from (the Express request, as your middleware left it, e.g. with `req.user` set). Without such a request it falls back to the shell socket's HTTP upgrade request (a raw Node `IncomingMessage`: headers such as `Cookie`, URL, socket; no Express middleware has run on it). Returning `null`/`undefined`, throwing, or returning a different or disabled user closes the shell with 4401 `session ended`; a user that no longer holds `shell:execute` (after the `isAdmin` → `admin` group mapping) closes it with audit reason `permission removed`.

**Events and logs sockets opened by adapter users** are re-checked the same way: every `sessionCheckIntervalMs` of the server's `shell` options (default 30 s, capped at 60 s; it applies whether or not the shell is enabled), and on every users/groups change, the adapter runs again on the ticket request. `null`/`undefined`, a different user, a disabled user, an exception, or a user who no longer holds the socket's permission (`logs:read` for the logs socket; the events socket only needs authentication) closes the socket with 4401 `session ended`. A slow adapter never stacks checks: a socket whose check is still running is skipped.

A user the adapter returns with `disabled: true` is refused (401 `account disabled`) on requests and ticket issuance.

The admin dashboard plugin keeps its own login at `/auth/login`; both plugins can be mounted at the same prefix.

## Read-only stores

When the host application owns the users or groups (a custom `ICliUserStore`/`ICliGroupStore` over its own accounts and roles), mark them read-only instead of throwing from the store's write methods:

```typescript
const usersPlugin = new CliUsersBuilder()
    .setAuthAdapter(hostAdapter)
    .setUserStore(new HostUserStore()) // only the read methods need real implementations
    .setReadOnlyUsers()
    .setReadOnlyGroups()
    .build(broadcast);
```

(or `setOptions({ readOnlyUsers: true, readOnlyGroups: true })`)

- **`setReadOnlyUsers()`** (`readOnlyUsers: true`): `POST /users`, `PUT /users/{idOrName}` (self updates too), `DELETE /users/{idOrName}`, `PUT /users/{idOrName}/password` and `POST`/`PUT`/`DELETE /groups/{name}/members/{idOrName}` answer `501 { "error": "Users are managed by the host application" }` without calling any store (before authentication; with an auth adapter, password changes keep answering `501` `Authentication is managed by the host application`). No `root` user is seeded, and deleting a group leaves the users' memberships alone.
- **`setReadOnlyGroups()`** (`readOnlyGroups: true`): `POST /groups`, `PUT /groups/{name}` and `DELETE /groups/{name}` answer `501 { "error": "Groups are managed by the host application" }` without calling the store, and the built-in `admin` and `users` groups are not seeded (the host's store provides the groups it needs).
- Reads keep working. `GET /sessions/current` and the login response (`session`) carry `usersReadOnly` and `groupsReadOnly` (always present, `false` by default) so clients can hide `adduser`, `groupadd` and the like.

## License

MIT
