# System notifications and updates: the contract

The Node server is the reference. The Python and .NET servers implement the same routes, JSON, keys, events and
sources, so the dashboard (bell, Notifications page, Plugins → Updates) works against any of them. Names in
`snake_case` (Python) or `PascalCase` (.NET) follow each platform; everything on the wire is as written here.

## 1. The notifications service (core)

One service per server: `builder.notifications` (Node), `builder.notifications` / `CliBuilder.Notifications`
(.NET), `builder.notifications` (Python). Plugins reach it through their entry context (`context.notifications`,
optional: older servers have none) or the builder.

```ts
notify(input: {
  key: string;              // [A-Za-z0-9._:@/+-]{1,200}: names the condition
  kind: string;             // [a-z0-9][a-z0-9._-]{0,39}: update, restart, plugin, security, a plugin's own
  severity: 'info' | 'warning' | 'error';
  title: string;            // 1-200 characters, trimmed
  message: string;          // 0-2000 characters, trimmed
  link?: string;            // a dashboard path starting with one "/" or an absolute http(s) URL
  requiredPermission?: string; // resource:action
  data?: object;            // at most 8 KB of JSON
}): Notification
resolve(key): boolean                      // removes it: the condition ended
resolveMissing(prefix, keepKeys): number   // removes keys starting with prefix that are not in keepKeys
get(key): Notification without `read` | undefined
```

Invalid input throws (an error naming the field). Rules:

- **Dedupe by key.** `notify` with a key that exists updates that notification (same `id`, same `createdAt`). When the
  content (`kind`, `severity`, `title`, `message`, `link`, `requiredPermission`, `data`) is identical nothing
  happens: no write, no event. When it changed, `updatedAt` is now and the read and dismissed state is reset for
  everyone (it is new information).
- **`id`** is `n_` + 16 lowercase hex characters, generated on creation.
- **Visibility.** A user sees a notification when it has no `requiredPermission` or they hold it (the server's
  permission matching, wildcards included), and they did not dismiss it. On a server without sign-in (no auth provider
  protecting it) there is a single reader, `anonymous`, who sees everything.
- **Per-user state.** Each notification keeps `readBy` and `dismissedBy` (user ids). Dismissing also marks read.
- **Order.** Newest `updatedAt` first, then newest `createdAt`.
- **Retention.** At most 500 notifications (the oldest `updatedAt` dropped first) and 30 days after the last change;
  pruned on load and whenever the list is read or changed. Options: `maxItems`, `maxAgeDays`.
- **Persistence.** `<dataDir>/notifications.json`, written atomically (temporary file, then rename) on every change;
  option `file` (`false`/`None`/`null`: memory only). A damaged file is logged and ignored; damaged entries dropped.

```json
{
  "version": 1,
  "items": [
    {
      "id": "n_3f0c9a1b2d4e5f60",
      "key": "update:server:weather",
      "kind": "update",
      "severity": "info",
      "title": "Update available: Weather 1.2.0",
      "message": "@qodalis/cli-server-plugin-weather 1.0.0 → 1.2.0.",
      "link": "/plugins?tab=updates",
      "requiredPermission": "updates:read",
      "data": { "kind": "server", "name": "weather", "package": "@qodalis/cli-server-plugin-weather", "current": "1.0.0", "latest": "1.2.0", "source": "marketplace", "canUpdate": true },
      "createdAt": "2026-11-26T10:00:00.000Z",
      "updatedAt": "2026-11-26T10:00:00.000Z",
      "readBy": ["u_1"],
      "dismissedBy": []
    }
  ]
}
```

A notification as the API returns it is the stored one without `readBy`/`dismissedBy`, plus `read: boolean` for the
caller. Optional fields are left out when unset.

## 2. API

All under `/api/v1/qcli/notifications`. On a protected server every route needs a signed-in user and no specific
permission (each user sees their own); without sign-in the routes are open (one shared reader).

| Route | Answer |
|---|---|
| `GET /?unread=true&severity=warning&limit=50` | `200 { items: Notification[], unreadCount }`. `unread` `true`/`1`; `severity` `info`, `warning` or `error` (else 400); `limit` 1-500 (else 400). `unreadCount` counts every unread visible notification, whatever the filters. `Cache-Control: no-store`. |
| `POST /read-all` | `200 { marked, unreadCount }` (`marked`: how many were unread). |
| `POST /{id}/read` | `200 { item, unreadCount }`; 404 `{ error: "notification not found" }` when it does not exist or the caller cannot see it. |
| `DELETE /{id}` | Dismisses it for the caller: `200 { dismissed: true, unreadCount }`; 404 as above. |
| `DELETE /{id}?scope=all` | Clears it for everyone: needs `notifications:manage` (403 `{ error: "forbidden: missing permission notifications:manage" }`), `200 { cleared: true, unreadCount }`; 404 as above. |

New permissions in the core catalog, group `Server`, surface `cli`, right after `server:restart`:

- `updates:read`: "See the available updates and check for them"
- `notifications:manage`: "Clear system notifications for every user"

## 3. Event: `notification:changed`

Published on the event bus on every change and delivered on `/ws/v1/qcli/events`:

```json
{
  "type": "notification:changed",
  "timestamp": "2026-11-26T10:00:00.000Z",
  "action": "created",
  "id": "n_3f0c9a1b2d4e5f60",
  "key": "update:server:weather",
  "item": { "id": "n_…", "key": "…", "kind": "update", "severity": "info", "title": "…", "message": "…", "createdAt": "…", "updatedAt": "…", "read": false },
  "unreadCount": 3
}
```

- `action`: `created`, `updated`, `resolved`, `cleared` (removed for everyone), `read`, `read-all`, `dismissed`.
- `item` is present for `created`, `updated`, `read`, `dismissed` (absent for `resolved`, `cleared`, `read-all`).
- **Audience:** `read`, `read-all` and `dismissed` go to the acting user's sockets (`{ userId }`); the others to the
  holders of the notification's `requiredPermission` (everyone when it has none). On a server without sign-in every
  socket gets every event.
- **Personalised per socket:** the socket manager rewrites the message for each recipient: `unreadCount` is that
  user's unread count and `item.read` that user's read flag (the anonymous reader's on an open server). In-process
  subscribers of the bus get the event without them. (.NET/Python: a per-type hook in the events socket manager,
  like Node's `setPersonalizer(type, (message, auth) => message)`.)

The dashboard refetches its list on any `notification:changed` and takes `unreadCount` from the event.

## 4. Terminal command and MCP

`notifications` (module `notifications`, icon 🔔, no permission; it lists the caller's own):

- `notifications` / `notifications list [--unread] [--severity s]`: `N notification(s), M unread`, then one line per
  notification: `* ! 2026-11-26 10:00  <title>  (<id>)` (`*` unread, `i`/`!`/`x` for info/warning/error) and the
  message indented. Empty: `No notifications.` / `No unread notifications.`
- `notifications read <id> | --all`: `Read: <title>` / `Marked N notification(s) read.`
- `notifications clear <id> [--all]`: `Dismissed: <title>`; with `--all` `Cleared for everyone: <title>` or
  `Error: forbidden: missing permission notifications:manage`.
- `<id>` may be a unique id prefix or the key; `Error: notification not found: <id>`,
  `Error: <id> matches N notifications; use the full id`.

MCP (when on): `notifications_list` `{ unread?, severity?, limit? (default 50) }`, read-only, no permission, returns
`structuredContent` `{ items, unreadCount }`. The admin plugin adds `updates_list` `{ check? }` (`updates:read` or
`plugins:install` on a protected server) returning the updates result.

## 5. Sources and keys

Every source uses a stable key and resolves it when the condition ends. The server's own notifications need
`admin:access`; update notifications need `updates:read`.

| Key | Kind / severity | When | Resolved |
|---|---|---|---|
| `server.restart-required` | `restart` / `warning` | Changes wait for a restart (sync on every `server:restart-required` and at startup). Title `Restart required: 1 change waits for a restart` / `… N changes wait for a restart`; message: the descriptions, one per line; link `/`; `data.pending`: the ids. | Nothing pending (so after every restart). |
| `security.anonymous-admin` | `security` / `warning` | `allowAnonymousAdmin` is on (at startup). Title `Anyone can administer this server`; link `/config`. | At startup when off. |
| `plugin.failed:<name>` | `plugin` / `error` | A plugin (code or marketplace) failed to load at this start. Title `Plugin <name> failed to load`; message `<package>@<version>: <error>`; link `/plugins/<url-encoded package>`; `data`: plugin, package, version, source, error. | At the next start when it loads (`resolveMissing` over the states of this start). |
| `plugin.needs-configuration:<name>` | `plugin` / `warning` | Required settings without a value. Title `Plugin <name> needs configuration`; message `Set <a, b>, then restart the server.`; link `/config?provider=<settings provider id>`; `data.missing`. | Same as above. |
| `update:dashboard:<name>` | `update` / `info` | A dashboard plugin installed from the marketplace has a newer version. Title `Update available: <title> <latest>`. | When the check no longer finds it, or right after it is updated or removed. |
| `update:server:<name>` | `update` / `info` | A server plugin installed from the marketplace has a newer compatible version. | Same. |
| `update:code:dashboard:<package>`, `update:code:server:<package>` | `update` / `info` | A plugin the host adds in code has a newer version in the marketplace. Title `Update in code: <title> <latest>`; the message names the install command. | When the check no longer finds it. |
| `update:core:<package>` | `update` / `info` | The server package has a newer version. Title `Server update available: <latest>`. | When the check finds none. |

Update notifications link to `/plugins?tab=updates`; their `data` is `{ kind, name, package, current, latest, source,
canUpdate }`. The plugin sync runs once this start loaded its plugins (Node: after `serverPlugins.ready()`); the
security and restart syncs at creation.

## 6. Update checker (admin plugin)

Lives in the admin plugin (it owns the marketplace clients); only when the marketplace is on.

- **Schedule:** every 6 hours. With the jobs plugin mounted, a job `updates:check` (name `updates:check`, group
  `system`, tags `system`, `updates`, interval `21600s`); else a timer. The first check runs 60 s after startup, or
  when the last result becomes 6 hours old if that is later. `setUpdateChecks({ enabled, intervalMs, initialDelayMs })`
  (`false`: no periodic checks; Check now still works). A check already running is joined, never run twice.
- **What it checks:**
  - Dashboard plugins: the marketplace's `kind=dashboard` list (pages of 100, at most 10), as annotated by the
    dashboard marketplace (`installed`, `updateAvailable`, `allowed`, `blockedReason`). `installed.source` `marketplace`
    → `dashboardPlugins`; `code` → `codePlugins` with `install.node: npm install <name>@<latest>`.
  - Server plugins: `kind=server&platform=<this>` with `serverVersion` (the newest compatible version), annotated the
    same way. Marketplace installs → `serverPlugins`, `canUpdate` = `allowed`, `reason` = `blockedReason`. Code-added →
    `codePlugins` with `install` per platform: this platform's command first (`npm install <pkg>@<latest>`,
    `pip install --upgrade <pkg>==<latest>`, `dotnet add package <pkg> --version <latest>`), then the other platforms'
    from the marketplace item's `platforms` (their `install` when given, else the same patterns).
  - The server package: `<npmRegistry>/<package>/latest` (Node `@qodalis/cli-server-node`; Python PyPI
    `https://pypi.org/pypi/qodalis-cli-server/json` → `info.version`; .NET NuGet flat container
    `https://api.nuget.org/v3-flatcontainer/qodalis.cli/index.json` → the newest version) compared with the running
    version (prereleases compare as semver).
- **Failures:** a category that does not answer keeps its last items and notifications; `error` lists what failed,
  e.g. `dashboard plugins: marketplace unreachable; server package: npm registry unreachable`.
- **After an install, update or removal** (the marketplaces' `server:plugins-changed` / `dashboard:extensions-changed`),
  updates whose installed version caught up, or that were removed, are dropped and their notifications resolved
  without asking the marketplace.
- **Persistence:** the last result in `<dataDir>/updates.json` (without `checking`); on load the server item's
  `current` and `updateAvailable` are recomputed from the running version.

### `GET /api/v1/qcli/updates` and `POST /api/v1/qcli/updates/check`

Behind the admin sign-in; on a protected server `updates:read` or `plugins:install` (403
`{ error: "forbidden: missing permission updates:read" }`). `GET` answers the last result (`Cache-Control: no-store`),
`POST /check` checks and answers the new one (502 `{ error }` only if the check itself throws).

```json
{
  "checkedAt": "2026-11-26T10:00:00.000Z",
  "checking": false,
  "error": "dashboard plugins: marketplace unreachable",
  "server": {
    "kind": "core", "name": "@qodalis/cli-server-node", "package": "@qodalis/cli-server-node", "title": "Server",
    "current": "1.0.0-beta.33", "latest": "1.0.0-beta.34", "source": "npm", "updateAvailable": true, "canUpdate": false,
    "reason": "update the server packages in code (every @qodalis/cli-server-* package shares the version)",
    "install": { "node": "npm install @qodalis/cli-server-node@1.0.0-beta.34" }
  },
  "dashboardPlugins": [
    { "kind": "dashboard", "name": "@acme/cli-dashboard-tickets", "package": "@acme/cli-dashboard-tickets", "title": "Tickets", "icon": null,
      "current": "1.0.0", "latest": "1.1.0", "source": "marketplace", "updateAvailable": true, "canUpdate": true }
  ],
  "serverPlugins": [
    { "kind": "server", "name": "weather", "package": "@qodalis/cli-server-plugin-weather", "title": "Weather", "icon": "🌤️",
      "current": "1.0.0", "latest": "1.2.0", "source": "marketplace", "updateAvailable": true, "canUpdate": false, "reason": "unverified publisher" }
  ],
  "codePlugins": [
    { "kind": "server", "name": "jobs", "package": "@qodalis/cli-server-plugin-jobs", "title": "Jobs", "icon": null,
      "current": "1.0.0-beta.30", "latest": "1.0.0-beta.33", "source": "code", "updateAvailable": true, "canUpdate": false,
      "reason": "update in code",
      "install": { "node": "npm install @qodalis/cli-server-plugin-jobs@1.0.0-beta.33", "python": "pip install --upgrade qodalis-cli-server-plugin-jobs==1.0.0b33" } }
  ],
  "count": 4
}
```

- Before the first check: `checkedAt: null`, `server: null`, empty lists, `count: 0`.
- Lists hold only packages with a newer version; `server` is always present once checked (`updateAvailable` false when
  current). `count` = the three lists plus 1 when the server has an update (the dashboard's Updates badge).
- `name` is the marketplace name (the key of the update routes), `package` this platform's package.
- Updating a marketplace item uses the existing routes (`PUT /dashboard/marketplace/installed/{name}`,
  `PUT /server/marketplace/installed/{name}`) with their confirmation and restart flow.

## 7. Tests a port should have

Dedupe (same key → same id, identical content is a no-op, changed content unread again), resolve and
`resolveMissing`, permission filtering (list, read, dismiss and clear of hidden ones are 404), per-user read and
dismiss state, clear for everyone with `notifications:manage`, persistence across a restart (read state included),
retention (cap and age), invalid input, the WS event with its per-socket `unreadCount`, the command, the MCP tool, the
four server sources (restart, security, plugin failed, needs configuration) with their resolution at the next start,
and the update checker against a fake marketplace and registry (marketplace vs code items, install commands, the
server package, resolution, failures keeping the last items, joining a running check, persistence, schedule via the
jobs plugin or a timer) plus `/updates` permissions.
