# @qodalis/cli-server-plugin-audit

Audit log plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node): the audit log, its in-memory store and its REST API at `/api/v1/qcli/audit`, shown as the admin dashboard's Audit page and read by the CLI's `audit` command. Implements the same contract as the .NET (`Qodalis.Cli.Plugin.Audit`) and Python servers.

The [users plugin](../users/README.md) adds it and records sign-ins, user, group, session and token changes there, so a host that only adds the users plugin keeps its audit log. A host can also use it without the users plugin, and record its own changes through its store.

## Install

```bash
npm install @qodalis/cli-server-plugin-audit
```

## Usage

```typescript
import { CliAuditBuilder } from '@qodalis/cli-server-plugin-audit';

const auditPlugin = new CliAuditBuilder()
    .setStore(new MyAuditStore()) // optional: in memory by default
    .build();

mountPlugin(auditPlugin);

// A host records its own changes
await auditPlugin.store.log({ timestamp: Date.now(), event: 'plan_changed', username: 'alice', actor: 'root', properties: { from: 'free', to: 'pro' } });
```

With the users plugin, either let it build the audit plugin (`new CliUsersBuilder().setAuditStore(store)` sets its store) or pass your own:

```typescript
const auditPlugin = new CliAuditBuilder().setStore(new MyAuditStore()).build();
const usersPlugin = new CliUsersBuilder().setAuditPlugin(auditPlugin).build();

mountPlugin(usersPlugin); // serves the audit API at /api/v1/qcli/audit and lists the audit plugin
```

`usersPlugin.auditPlugin` is the audit plugin the users plugin records in.

## Builder

| Method | Default | Description |
|---|---|---|
| `setStore(store)` | `InMemoryAuditStore` | Where the log is kept (any `ICliAuditStore`) |
| `setGuard(guard)` | none | Middleware protecting the routes: `(permission) => RequestHandler[]` (the users plugin installs its own) |
| `build()` | | `{ prefix: '/api/v1/qcli/audit', router, store, installedPlugin, protect(guard), setEventBus(bus) }` |

## Events

Every entry stored through `store.log` (by the users plugin, the server or the host) publishes `audit:recorded`
(audience `audit:read`) on the server's event bus, with the entry as `GET /audit` returns it (its `timestamp` is the
message's ISO 8601 `timestamp`). `mountPlugin(auditPlugin)` hands it the server's bus; the users plugin hands the bus
to the audit plugin it serves. `store` stays the store you set: its `log` method is instrumented in place.

## API

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/v1/qcli/audit` | `audit:read` | Entries, newest first. `?event=&username=&actor=` filter exactly and case-insensitively (`username`: the user an entry is about, `actor`: who did it); `?from=&to=` (ISO 8601 or epoch milliseconds) keep the entries with `from <= timestamp < to`; `?limit=` (default 100, at most 1000) and `?offset=` page. A negative or non-integer `limit`/`offset`, or a bad time, answers `400 { "error" }` |
| DELETE | `/api/v1/qcli/audit` | `audit:clear` | Clears the log, then records `audit_cleared` with the caller as actor; 204 |

On a protected server (the users plugin's `protectServer`) the server's route policy requires the permissions above; the users plugin also checks them on the routes it serves.

## Storage

The contract is in `@qodalis/cli-server-abstractions` (`AuditEntry`, `AuditMetadata`, `AuditQueryOptions`, `ICliAuditStore`, `pruneAudit`) and re-exported here, so a store of your own needs only the abstractions:

```typescript
import { ICliAuditStore, AuditEntry, AuditQueryOptions } from '@qodalis/cli-server-abstractions';

class MyAuditStore implements ICliAuditStore {
    async log(entry: AuditEntry): Promise<void> { /* ... */ }
    // newest first; honour every option, including from (inclusive) and to (exclusive)
    async getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]> { return []; }
    async clear(): Promise<void> { /* ... */ }
    async prune(before: Date): Promise<number> { /* optional */ return 0; }
}
```

`InMemoryAuditStore` keeps the latest 1000 entries; `login_failed` entries are capped separately (latest 200) so a flood of failed sign-ins cannot evict the rest. Both limits are constructor arguments. `pruneAudit(store, before)` deletes older entries when the store implements `prune`.

There is no database store in this server: implement `ICliAuditStore` over your own storage to keep the log across restarts.

## Dashboard page

The admin dashboard's Audit page is `@qodalis/cli-dashboard-module-audit`, copied into this package at build
(`dashboard/`, `npm run copy-dashboard`: the sibling `cli-server-dashboard/modules/audit/dist`, else the npm
package) and served at `/qcli/modules/audit` (outside the API, so the dashboard loads it without a token); it shows for
users with `audit:read`. The users plugin serves it with the audit plugin it adds (`setAuditPlugin(new CliAuditBuilder().setDashboardDir(...).build())` to change it). `new CliAuditBuilder().setDashboardDir(dir)` serves another build, `setDashboardDir(false)` leaves the page out.

## Terminal commands

No server-side command: the web CLI plugin [`@qodalis/cli-users`](https://www.npmjs.com/package/@qodalis/cli-users)
reads the log through `GET/DELETE /api/v1/qcli/audit`.

| Command | Permission | Does |
|---|---|---|
| `audit` | `audit:read` | The audit log, newest first |
| `last [user]` | `audit:read` | Sign-in history (logins, logouts, failures) |
| `audit clear` | `audit:clear` | Clears the audit log (asks first) |

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install audit`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) mounts the audit log with an in-memory store of the size set.

| Setting | Type | Default | |
|---|---|---|---|
| `maxEntries` | number | `1000` | 100-1000000; the oldest are dropped |

On a server whose users plugin is mounted in code, the audit plugin is already there (the users plugin brings it): the
installed copy is skipped (`skipped: already installed by the host`). Every setting needs a restart.

## License

MIT
