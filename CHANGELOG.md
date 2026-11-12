# Change Log

Notable changes to the Node CLI server packages (`@qodalis/cli-server-node`, `@qodalis/cli-server-abstractions`,
`@qodalis/cli-server-plugin-*`). Every package shares one version with the .NET and Python servers.

## Unreleased

- **Jobs: tags.** `tags` on a job (`CliJobOptions.tags`: free-form labels such as `country:ro`, `bank`; each 1-64
  characters without commas, at most 20, duplicates ignoring case dropped), always present in job info (`[]` when
  none). `GET /api/v1/qcli/jobs?tag=a&tag=b` (repeatable or comma-separated) lists the jobs that have every tag,
  ignoring case; `/executions` and `/stats` take `tag=` too. `PUT /jobs/{id}` accepts `tags` (replaces them, `null`
  clears, invalid ones are 400 `INVALID_VALUE`). MCP `jobs_list` takes `tags` and shows them. Same on the .NET and
  Python servers.

## 1.0.0-beta.24

- The admin plugin embeds dashboard 1.0.0-beta.19: a phone layout (below 768 px the sidebar is a drawer, stat cards wrap, panels stack and tables scroll in their container) and tests for the live log tail.

## 1.0.0-beta.23

- The admin plugin embeds dashboard 1.0.0-beta.18: pages update live from the server events (jobs, job detail, files, audit, overview, events), a run's full error in a details dialog, max concurrent runs in the job editor, and no session token in WebSocket URLs when the ticket request fails.

- **Jobs: max concurrent runs, and no job started twice**, the same on the .NET and Python servers
  (spec: web-cli `docs/superpowers/specs/2026-11-06-job-concurrency-design.md`):
  - `maxConcurrentRuns` per job (integer >= 1, default 1), in the code options and `PUT /api/v1/qcli/jobs/{id}`
    (400 `INVALID_VALUE` otherwise). A run holds its slot until it ends, its retries and their delays
    included; taking a slot is atomic, so timer ticks, triggers and the run on start never exceed the limit.
  - When full: `skip` drops the due run (a trigger answers 409 `JOB_ALREADY_RUNNING`), `queue` queues one coalesced
    run, `cancel` cancels the oldest run and starts the new one once it ended (queued meanwhile). Lowering the limit
    cancels nothing.
  - `POST /trigger` answers at once, no longer waiting for the run to finish: `{ "ok": true, "message": "Job
    triggered", "queued": false }` or `{ "ok": true, "message": "Job queued", "queued": true }`; MCP `jobs_trigger`
    says `Job queued` when queued. `triggerAsync` resolves `{ queued }` once the run started or was queued.
  - Job info adds `maxConcurrentRuns`, `runningExecutionIds` (the executing attempts, oldest first; a run in its
    retry delay has none) and `queued`; `currentExecutionId` is the newest executing run, `null` when none. `POST /cancel` cancels
    every running run and drops a queued one, as does `stop`.
  - `runOnStart` runs only when the job is due: an interval job that never ran or whose next run is due, a cron job
    that never ran or missed an occurrence; a job without a schedule still runs on every start.
  - Cron jobs compute the next occurrence from the one that fired, so an early timer never runs it twice; a cron
    run no longer delays the next occurrence until it ends (the overlap policy decides).
  - On start, runs a previous process left `running` are finished as `cancelled` with
    `Interrupted: the server stopped during the run`, completed at their last log entry (or their start).
  - Fixed: a job with a `timeout` cancelled by hand reported `job:timed_out` (and `timed_out`); it is `cancelled`.
  - `JobRegistration.queue` is replaced by `runs` and `queued`.
- **Server events**, the same on the .NET and Python servers
  (spec: web-cli `docs/superpowers/specs/2026-11-06-server-events-design.md`):
  - `createCliServer` returns `eventBus` (`CliEventBus`, typed `ICliEventBus` in `@qodalis/cli-server-abstractions`):
    `publish(type, data?, audience?)` and `subscribe(pattern, handler)` (`*`, `ns:*` or an exact type;
    `cliEventPatternMatches`). Handlers run in subscription order; one that throws is logged and never fails the
    publishing action. The events WebSocket is the bus's subscriber of `*`.
  - Each message is one flat JSON object: `type`, `timestamp` (ISO 8601 UTC, added unless set), the publisher's
    fields and, when known, `actor`.
  - Audience: an event goes to every socket, to the sockets holding a `permission`, to a `userId`'s sockets, or with
    both to the user or the permission holders. Servers without the users plugin deliver everything to everyone;
    in-process subscribers receive every event. `eventSocketManager.broadcastMessage` still works: on a protected
    server namespaced raw messages need their namespace's read permission (`job:*` → `jobs:read`, `user:*` →
    `users:read`, ...).
  - New events: `job:triggered`, `job:updated`, `job:runs-deleted` (jobs API and MCP); `job:paused`, `job:resumed`
    and `job:stopped` carry `status`; `user:created|updated|deleted`, `group:created|updated|deleted`,
    `token:created|revoked`, `session:opened|closed` (users plugin); `fs:changed` (`upload`, `mkdir`, `delete`,
    `write`, `move`, `copy`: the file storage provider shared by the filesystem API and the MCP `fs_*` tools);
    `command:executed` (`/execute`, `/execute/stream` and MCP command tools: the processor name, success, duration,
    caller; never arguments); `audit:recorded` (every entry the audit plugin's store keeps). Job events need
    `jobs:read`, user/group/session events `users:read`/`groups:read`/`sessions:read`, token events `tokens:read` or
    the owner, `fs:changed` `files:read`, `command:executed` and `audit:recorded` `audit:read`.
  - The jobs and users builders take the bus (`build(eventBus)`); the broadcast-function parameter keeps working.
    Built with neither, `mountPlugin` hands them the server's bus (new optional `MountablePlugin.setEventBus`, also on
    the jobs and audit plugin results; auth providers get `eventBus` in `attachToServer`). The admin plugin takes
    `eventBus` in `build()` and publishes `log:entry` with audience `logs:read`.

## 1.0.0-beta.22

- The admin plugin embeds dashboard 1.0.0-beta.17: logs jump to newest, pause, copy an entry and collapsed exceptions; jobs run again and delete runs from the recent runs table.

## 1.0.0-beta.21

- The admin plugin embeds dashboard 1.0.0-beta.16: delete job runs (one, a result's or every finished one), older log
  entries load when scrolling up with stable paging, and themed dropdown arrows.
- **Jobs:** delete runs, the same on the .NET and Python servers. `DELETE /api/v1/qcli/jobs/{id}/history/{execId}`
  deletes one run and its logs (`{ "message": "Run deleted" }`; 404 `JOB_NOT_FOUND` or `EXECUTION_NOT_FOUND` when the
  run is missing or another job's, 409 `EXECUTION_RUNNING`, 501 `NOT_SUPPORTED` when the storage has no
  `deleteExecution`). `DELETE /api/v1/qcli/jobs/{id}/history?status=` deletes every finished run of the job, or only
  those with the status, and answers `{ "deleted": <count> }`; running runs are never deleted. `jobs:manage` on a
  protected server. The scheduler (`ICliJobScheduler`) gains `deleteExecutionAsync` and `deleteExecutionsAsync`, and
  the MCP endpoint a `jobs_delete_runs` tool (one run by `executionId`, else every finished run or those with `status`).

## 1.0.0-beta.20

- Version only, to keep every server package on one version: the .NET jobs EF Core store fix of this release has no Node/Python counterpart.

## 1.0.0-beta.19

- The admin plugin embeds dashboard 1.0.0-beta.15: charts on the Overview, Jobs, Logs, Audit and Commands pages, filters kept in the URL, sortable tables and a Ctrl+K command palette, using the endpoints below.

Read-only endpoints for the admin dashboard's charts, the same on the .NET and Python servers. Older dashboards ignore
them.

- **Jobs:** `GET /api/v1/qcli/jobs/stats?since=&until=&buckets=&job=&group=`: runs per outcome in equal columns of the
  range (default the last 24 hours, 24 columns, at most 200), totals and per-job statistics (success rate, average,
  p95 and longest duration, last failure, the 12 latest runs). It reads every run in the range page by page through
  the storage's execution query, so it works with every storage provider. `jobs:read` on a protected server.
- **Admin:** `GET /api/v1/qcli/logs/histogram?from=&to=&buckets=` counts the log buffer per level in each column,
  with the filters of `GET /logs`. `GET /logs` (and the histogram) now take several levels (`level=WARN,ERROR`), a
  `service` (the entry's source) and search the source as well as the message. `GET /logs` also takes `from`/`to`
  and answers like the .NET server: `store: "memory"`, `persistent: false`, `limit`, `offset`, `hasMore` and
  `services` (the distinct sources) next to `entries` and `total`, so the dashboard filters on the server.
- **Admin:** `GET /api/v1/qcli/status/history?minutes=` (default 60, at most 1440): the plugin samples memory, CPU,
  WebSocket connections and shell sessions every 15 seconds and keeps 24 hours in memory (unref'd timer, stopped by
  `dispose()`). `GET /status` reports the latest CPU sample as `cpuUsagePercent`.
- **Core:** the executor counts every command run through `/execute`, `/execute/stream` and the MCP tools
  (executions, failures, duration, last run and failure, per root command). `GET /api/v1/qcli/commands/stats` returns
  them, most used first; same auth as `GET /commands`.
- **Audit:** `GET /api/v1/qcli/audit` takes `from` and `to` (ISO 8601 or epoch milliseconds; `from <= timestamp < to`),
  and `AuditQueryOptions` gains `from`/`to`, which `InMemoryAuditStore` applies. A store of your own should apply them
  too.

## 1.0.0-beta.18

Every package moves to the version of the .NET server's release, which adds a Seq logs plugin
(`Qodalis.Cli.Plugin.Logs.Seq`) and new filters on `GET /api/v1/qcli/logs` (`service`, `from`, `to`, several levels).
This server's logs API keeps its current filters.

- The admin plugin ships dashboard 1.0.0-beta.14. Its Logs page shows this server's logs oldest first, so older pages
  load on top and live entries arrive at the bottom.

## 1.0.0-beta.17

### Audit plugin

- The audit log is a plugin of its own, **`@qodalis/cli-server-plugin-audit`** (`new CliAuditBuilder().build()`,
  mounted with `mountPlugin`): the entries, the in-memory store and `GET/DELETE /api/v1/qcli/audit`, listed on the
  dashboard's Plugins page and shown as its Audit page. The users plugin adds it (`usersPlugin.auditPlugin`, served by
  its router at `/audit` and listed after it among the installed plugins), so existing hosts keep their audit log; a
  host can use it without the users plugin. See [its README](plugins/audit/README.md).
- The contract moves to **`@qodalis/cli-server-abstractions`** (`AuditEntry`, `AuditMetadata`, `AuditQueryOptions`,
  `ICliAuditStore`, `pruneAudit`), so a store of your own needs only the abstractions. `InMemoryAuditStore` is in
  the audit plugin. The users plugin still re-exports the contract, `InMemoryAuditStore` and `CliAuditBuilder`, so
  existing imports keep working; only the deep import `plugins/users/stores/in-memory-audit-store` is gone.
- `CliAuditBuilder.setStore(store)` keeps the log elsewhere; the users plugin's `setAuditStore(store)` (or the
  `auditStore` option) still works and does the same. A host that builds the audit plugin itself passes it with
  `new CliUsersBuilder().setAuditPlugin(auditPlugin)` (mounting it too is fine); a store and a plugin that disagree
  are refused.
- The route policy protects the audit API itself (`audit:read` for `GET`, `audit:clear` for `DELETE`;
  `CliServerPermissions.AuditRead` / `AuditClear`); the users plugin no longer authenticates `/audit` as one of its
  own routes, but still checks its sign-in and those permissions on the API it serves. Clearing records
  `audit_cleared` with the caller (`actor`, `actorId`, session and address).
- `GET /audit` answers `400 { "error": "limit and offset must be integers >= 0" }` for a negative or non-integer
  `limit` or `offset`, and `limit=0` returns no entries.
- `mountPlugin` lists the further packages a plugin brings along (`installedPlugins`): the users plugin lists the
  audit plugin.
- The admin status reports the `audit` feature when the audit plugin is installed (was: the users plugin).
- No database store ships with this server (the .NET server's `Qodalis.Cli.Plugin.Audit.EfCore` has no Node
  counterpart): implement `ICliAuditStore` to keep the log across restarts.

### Admin

- The admin plugin ships dashboard 1.0.0-beta.13: the Terminal page is shown on every server again (it was hidden
  without an OS shell).

### Other packages

- Released at `1.0.0-beta.17` with the .NET and Python servers.

## 1.0.0-beta.15

### Installed plugins

- The admin plugin lists the installed server plugin packages at `GET /api/v1/qcli/plugins/installed` (`id`, `name`,
  `version`, `description`), shown on the dashboard's Plugins page (dashboard 1.0.0-beta.12). Mounted plugins
  (`mountPlugin`), modules, filesystem and data-explorer providers list themselves; a package of your own calls
  `builder.addInstalledPlugin(...)`. A plugin router mounted with `app.use` is listed with
  `builder.addInstalledPlugin(plugin.installedPlugin)`.
- The admin status reports the `audit` feature when the users plugin is installed (the dashboard's Audit page).

### Audit log

- Audit entries gain `target` (what the event is about when it is not a user; the group events set `group:<name>`)
  and `properties` (the application's own values); `authService.audit({ ..., target, properties })`.
- `GET /audit` and `AuditQueryOptions` gain `actor` and `offset`. Without a `limit` the newest 100 entries are
  returned (all before), at most 1000.
- `ICliAuditStore.prune?(before)` deletes old entries (`pruneAudit` keeps everything for a store without it; the
  in-memory store implements it).

### Jobs

- Stable job ids: `CliJobOptions.id`, by default the name (`name-2`, ... for duplicates), so saved pauses and history
  find their job again after a restart. Ids may not contain `/`, `\`, `?` or `#`; a default id replaces them.
- A saved pause or stop is kept across restarts, but `enabled: false` in the code always keeps a job stopped.
- Interval jobs keep their rhythm across restarts and pauses (next run = last run + interval); `runOnStart` runs a
  job once right after the scheduler starts.
- Inside a job: `context.properties` (saved with the run and returned by the API and the `jobs_history` MCP tool) and
  `context.discard()` (leave a completed run that found nothing to do out of the history). Implementers of
  `ICliJobExecutionContext` must add them. A run whose properties cannot be saved is saved without them.
- `GET /api/v1/qcli/jobs/executions?job=&group=&status=&since=&limit=&offset=`: runs across jobs, newest first;
  `JobExecutionQuery`, optional `ICliJobStorageProvider.queryExecutions`, `prune(before)` and `deleteExecution(id)`
  (with the helpers `queryJobExecutions`, `pruneJobExecutions`, `deleteJobExecution` for the defaults), and
  `CliJobScheduler.queryExecutions`.
- `ICliJobScheduler` (implemented by `CliJobScheduler`) for the host's own code.

### Other packages

- Released at `1.0.0-beta.15` with the .NET and Python servers; the admin plugin ships dashboard 1.0.0-beta.12.

## 1.0.0-beta.14

### Dashboard name and icon

- `CliAdminBuilder.setBranding({ name, iconUrl, cliName })`: the name and icon an application ships the dashboard
  under, and its terminal's name, served in `/qcli/admin/theme.json` and validated when set. Defaults: Qodalis Cli
  Admin with the Qodalis Solutions logo. See [Name and icon](plugins/admin/README.md#name-and-icon).

### Other packages

- Released at `1.0.0-beta.14` with the .NET and Python servers; no other change.
