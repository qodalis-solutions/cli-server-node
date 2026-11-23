# Change Log

Notable changes to the Node CLI server packages (`@qodalis/cli-server-node`, `@qodalis/cli-server-abstractions`,
`@qodalis/cli-server-plugin-*`). Every package shares one version with the .NET and Python servers.

## Unreleased

- **Users and Account pages.** The users plugin serves the dashboard's Users page (users, groups, sessions; `users:read`, at `/qcli/modules/users`) and Account page (the signed-in user's profile and password change; every user, at `/qcli/modules/account`), both from `@qodalis/cli-dashboard-module-users` (copied into `dashboard-users/`; `setUsersDashboardDir(dir | false)`), also when the host application signs users in. New dashboard extension group `account`: listed in the dashboard's account menu (the signed-in user's menu) instead of the sidebar.
- **Job history without logs in lists, and a run summary** (cli-server-dotnet#96, as on the .NET and Python servers). `JobExecutionQuery.includeLogs` (default false) and `JobExecution.logCount`: a storage may list runs without their log entries and set `logCount` instead; `getExecution` (the run detail endpoint, `server jobs logs`, the dashboard's log panel) always has them, and the list endpoints' and MCP `jobs_history`'s `logCount` use the storage's count. The scheduler asks for the logs when it finishes the runs a previous process left running (it saved them back without logs from a storage that leaves them out). New optional `ICliJobStorageProvider.summarizeExecutions(since, jobIds?)` and `summarizeJobExecutions(storage, since, jobIds?)`: per job and status, the number of runs and the start of the newest one (`JobExecutionSummary`); the in-memory storage implements it, other storages get it from their runs a page at a time. The in-memory storage keeps the logs in its lists. (The Node server has no SQL job storage, so there are no indexes to add.)
- **Plugin pages leave the dashboard core.** Jobs, Audit, API tokens, Filesystem and Data explorer are dashboard modules (`@qodalis/cli-dashboard-module-<name>`) that the plugins owning their APIs embed and serve at `/qcli/modules/<id>`: the jobs plugin (Jobs, with Overview cards and palette entries), the audit plugin (Audit; the users plugin serves it with the audit plugin it adds), the users plugin (API tokens, not in guard-only mode), the server (Filesystem with a file storage provider, Data explorer with a data explorer provider). `setDashboardDir(dir | false)` on the jobs, audit and users builders and `builder.setDashboardModuleDir('filesystem' | 'data-explorer', dir | false)` serve another build or leave the page out. A mounted plugin's `dashboardPages` (from `dashboardModulePage(dir, info)` in the abstractions, with `findDashboardModule` and `resolveDashboardModulePage`) are registered and served without a token; the databases plugin uses it too and declares `widgets: ['overview']`.
- **Dashboard extensions: `widgets` and `search`.** `widgets` lists the slots a module fills besides its page (`overview`: cards on the Overview; `palette`: command palette entries), `search` a path below the page where search text goes (`/?q=`, for the palette's "Search <title> for …"). Both are validated and listed by `GET /api/v1/qcli/dashboard/extensions`.
- **Databases** (`@qodalis/cli-server-plugin-databases`, new): the server's relational databases (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite) with their stats and migrations. **Stats** (`GET /api/v1/qcli/databases/:db/stats`): server version and uptime, size (data, indexes, log), connections (active, open, max), cumulative load counters (queries, transactions, commits, rollbacks, rows read and written), cache hit ratio and the 10 largest tables; each metric is collected on its own, so one the database refuses (e.g. SQL Server without `VIEW SERVER STATE`) is listed in `unavailable` instead of failing the rest. **Migrations**: versioned schema changes from a folder of SQL files (`NNNN_name.up.sql` / `.down.sql`) or code, applied in order under a lock per database (one run across processes), each in a transaction with its history row. `QcliMigrations` keeps the applied migrations (checksum, when, who, duration) and `QcliMigrationRuns` every run. Status per migration (`applied`, `pending`, `changed`, `missing`, `failed`); runs are refused while one changed or went missing unless forced. API at `/api/v1/qcli/databases` (`databases:read` / `databases:migrate`), terminal `databases` (alias `db`: `list`, `stats`, `migrations`, `up`, `down`), MCP tools `databases_list`, `databases_stats` and `migrations_status|runs|sql|up|down`, the dashboard's Databases page (`@qodalis/cli-dashboard-module-databases`, served at `/qcli/databases` and registered as a dashboard extension; `setDashboardDir`), dry runs showing the SQL, `applyOnStartup`, the `databases:migration-run` event and `migrations.up` / `migrations.down` audit entries.
- **Plugin table names** (#77): tables plugins create are `Qcli` + PascalCase with PascalCase columns, the same in the three servers: filesystem-sqlite's `files` is `QcliFiles` (`CreatedAt`, `ParentPath`, ...). Opening a database of an earlier release renames the table and its columns, keeping the data. Options: `tablePrefix` (default `Qcli`), per-table names (`tables`), `legacyTableNames` to keep the old names. `qcliTableName` and `CliTableNameOptions` are in the abstractions.
- **Plugins declare more when mounted**: `routePermissions` (`read` for GET/HEAD, `write` otherwise, enforced on a protected server), `module` (their terminal commands) and `permissions` (added to the catalog).
- **Dashboard extensions** (cli-server-dashboard `docs/extensions.md`): `builder.addDashboardExtension({ id, title, titles?, icon?, group?, order?, permission?, entry, styles?, version? })`, or a mounted plugin's `dashboardExtensions`, adds a page to the admin dashboard, which loads `entry` (an ES module the plugin serves) and mounts it. The admin plugin lists them at `GET /api/v1/qcli/dashboard/extensions` (`{ extensions: [...] }`, registration order, behind the dashboard's sign-in, `Cache-Control: no-cache`). Invalid entries fail startup with `invalid dashboard extension: <reason>`, a repeated id with `dashboard extension already registered: <id>`. `CliDashboardExtension` and `validateDashboardExtension` are in `@qodalis/cli-server-abstractions`.
- **Users in PostgreSQL** (`@qodalis/cli-server-plugin-users-postgres`, new): `createPostgresUsersStores(connectionString | PoolConfig | Pool, { tablePrefix })` returns PostgreSQL stores for users, groups, passwords, sessions, API tokens and the audit log, for `CliUsersBuilder`, so accounts, sign-ins and tokens survive restarts. Tables `QcliUsers`, `QcliGroups`, `QcliCredentials`, `QcliSessions`, `QcliApiTokens` and `QcliAuditEntries` (options `tablePrefix`, `tables`, `schema`); the schema is the databases plugin's migration source `qcli-users` (`init()` applies it; `stores.connection` and `stores.migrationSource` show it in the dashboard), and the first preview's `qcli_*` tables are renamed with their data. Behaviour matches the in-memory stores (the same contract tests run against both).

## 1.0.0-beta.29

- The admin plugin embeds dashboard 1.0.0-beta.26: pick a new token's permissions from the server's list, host tokens marked, and a Requests today column when the server counts API usage. The portal plugin serves `@qodalis/cli-server-portal` 1.0.0-beta.26.
- **Permission catalog.** The server keeps a catalog of known permissions (`{ name, description, group, surface }`): `builder.permissions`, `builder.addPermissions(entries, surface = 'host')`, `CliPermissionCatalog`, `CORE_PERMISSIONS`. Core registers its 11 route-policy permissions and the users plugin its 12 (both `cli`); the host adds the permissions its own routes check (`host`). Names are concrete lower-case `resource:action` permissions; an invalid entry throws `invalid permission entry: <name>`, a name registered twice (case-insensitive, also a host entry named like a users-plugin one) fails startup with `permission already registered: <name>`. The list order is every `cli` entry, then every `host` entry, each in registration order. The catalog is for choosing: CLI tokens and groups still accept any permission string.
- **`GET /api/v1/qcli/permissions`** (users plugin): the catalog entries the caller holds (what they may put on a token); `?all=true` needs `users:read` (`403 permission denied: users:read`); other `all` values → 400.
- **Token audience.** API tokens carry `audience`, `cli` (default, unchanged behaviour) or `host`, in every token view after `lastUsedAt`. `POST /tokens` accepts `audience: "cli"` only (`"host"` → 400 `host tokens can only be created by the host application`, other values → 400 `audience must be cli or host`). Stored tokens without an audience read as `cli`; any stored value other than `cli` reads as `host` (fail closed). Custom `ICliApiTokenStore`s must persist the field.
- **`usersPlugin.apiTokens`** (`ApiTokenManager`): the host creates, lists and revokes tokens for its users (`create`, `list`, `revoke`, `grantablePermissions`), with the HTTP routes' validation, limits, audit entries and events. `host` tokens need permissions, each a `host` catalog entry the user holds (stored with the catalog's spelling). `neverExpires` replaces `expiresInDays: null` there.
- **Host tokens are refused on the CLI's routes** with 403 `forbidden: host tokens cannot use CLI routes`, whether or not the server is protected: the users plugin's authenticated routes, the admin dashboard, the core routes, the MCP endpoint and every plugin mounted with `mountPlugin` (a router mounted with `app.use` is a host route). Public routes (version discovery, capabilities, sign-in, `POST /link`, `GET /link/:id`) are not checked. Sockets: the events and logs sockets answer 403 at the upgrade, the shell closes with 4403 and the text. Host tokens are accepted only by `requireAuth()` / `requirePermission(...)`, under `/api` too; an unguarded host route sees `req.qcliHostToken === true` and no identity. New core exports `HOST_TOKENS_CANNOT_USE_CLI_ROUTES`, `isCliRoute`, `hostTokenRefusal` and `ICliServerAuth.isHostTokenBearer` (a token-store lookup, never the auth adapter).
- **Public API plugin** (`@qodalis/cli-server-plugin-public-api`): `publicApi.guard(permission?)` admits only `host` tokens holding the permission, within per-account quotas from `setQuota(caller => ({ requestsPerDay, requestsPerMinute }))` (fixed UTC windows; every token of the account counts, revoked ones too), with `X-RateLimit-Limit/Remaining/Reset` and 429 + `Retry-After`; 403 `forbidden: no API access` for a 0 limit, 500 `internal server error` when the resolver or the usage store fails. Counters per token and day in an `IPublicApiUsageStore` (in memory by default); usage on the token views and `publicApi.usage.account(userId)`. Serves the host's OpenAPI document (`setOpenApi(object | path)`) at `/qcli/api/openapi.json` with the `qcliToken` bearer scheme, a top-level security requirement and `servers` added where missing, and Swagger UI for it at `/qcli/api/swagger`.
- **Docs plugin** (`@qodalis/cli-server-plugin-docs`): markdown pages from folders or code with front matter (`title`, `group`, `order`) and `{{ variables }}` (`baseUrl`, `name`, the host's), served at `/qcli/docs/pages` and `/qcli/docs/pages/<slug>`.
- **Portal plugin** (`@qodalis/cli-server-plugin-portal`): the prebuilt portal site (`@qodalis/cli-server-portal`) at `/qcli/portal` (or `/`, next to the host's routes, which it never shadows), with `portal.json` (name, logo, theme, footer links, the docs and API sections).
- **Users:** `req.qcliCaller` (`{ userId, userName, tokenId, audience, permissions }`) on routes guarded by `requireAuth`, `requirePermission` and the new `requireHostToken(...permissions)` (403 `forbidden: a host token is required` for sessions, adapter sign-ins and `cli` tokens, before the permission check); `setTokenUsageProvider(provider)` adds `usage` to the token views (only with a provider); `getUser(id)`; guard-only mode (`setGuardOnly()`: no routes, no seeding, no server protection) for a second service validating tokens over shared stores. Tokens should be created and revoked from one service only.
- **Core:** `createCliServer({ cliRoutes: false })` serves none of the CLI's routes or sockets; `MountablePlugin.cliRoutes: false` marks a plugin's prefix as host routes (not CLI routes, mounted on such a server too). Defaults unchanged.
- Shell: when the users plugin refuses a ticket with a 403, the shell closes with 4403 and the plugin's text (`password change required`, ...) instead of `forbidden`, which stays for texts over 123 bytes and the shell's own refusals.

## 1.0.0-beta.28

- The admin plugin embeds dashboard 1.0.0-beta.24: history retention on the job page and the pruning job's last run, collapsible job filters, Jobs and Recent runs tabs, paged lists, tag colours, run controls and row actions as button groups, last-runs tooltips that open the run, a navigation drawer on phones and tablets, shared selects, menus and dialogs, plugin icons, and uploads into folders.
- **Jobs: built-in history retention** (#94). `new CliJobsBuilder({ history: { maxAge, maxRunsPerJob, failedMaxAge, failedMaxRunsPerJob, pruneInterval } })` or `.setHistory(...)`, off by default; a job overrides them with `history` (or keeps everything with `keepAll`). The built-in system job `jobs:prune-history` (group `system`, runs on start when due) deletes the runs past the limits and records how many in its run's `deleted` property. Failed runs are counted on their own when `failedMaxRunsPerJob` is set; running runs and each job's newest run are never deleted; runs of jobs no longer registered follow the global limits. Storage providers get an optional `pruneHistory(retention)`. Job info carries `historyRetention` (the limits in force, `null` when none apply), for the dashboard.
- **Jobs: run ids in the statistics.** Each recent run in `GET /api/v1/qcli/jobs/stats` carries its execution `id`, so the dashboard's last-runs bars open the run.
- **`getCliCaller()`**: code a CLI request runs (a processor and the services it calls) reads the authenticated caller (`{ userId, userName, permissions, sessionId?, tokenId? }`) for sessions, API tokens (a terminal linked with `server add`) and the host's adapter sign-ins; undefined outside an authenticated CLI request.
- **Icons for the installed plugins.** `/api/v1/qcli/plugins/installed` returns each package's `icon` (one emoji or an image URL; absent when it has none): `CliInstalledPlugin.icon`, set by the plugin where it describes its package (`{ ...readInstalledPlugin(__dirname)!, icon: '💳' }`). Every package has one: Core 🖥️, Admin 🎛️, Audit 🛡️, Aws ☁️, Jobs ⏱️, Users 👥, Weather 🌤️, DataExplorer 📊, FileSystem 📁 (Json 📄, Sqlite 🪶, S3 🪣) and the data explorer providers (Sql 🪶, Postgres 🐘, Mysql 🐬, Mssql 🗃️, Mongo 🍃, Redis 🔴, Elasticsearch 🔍). The weather, aws and filesystem modules have icons too (`ICliModule.icon`: 🌤️, ☁️, 📁).

## 1.0.0-beta.27

- The admin plugin embeds dashboard 1.0.0-beta.23: built with Qodalis CLI 2.5.2; New token dialog, SQL editor with completion, the query as run ("Ran as"), module icons on the Plugins page, and the return to the dashboard after an external sign-in.

- **API tokens and terminal links with an external auth adapter (opt-in).** `CliUsersBuilder.allowApiTokens()` (`apiTokensWithExternalAuth`): a host that signs users in itself (`setAuthAdapter`) can also accept the plugin's API tokens. `qcli_pat_` bearer tokens are checked before the adapter, users signed in by the host create tokens (`POST /tokens`) and approve terminal links (`POST /link/code/{code}/approve`); both answered 501 before and still do without the option. The token's user comes from the user store by id (it must find the adapter's users and report `disabled`); keep tokens in a persistent `ICliApiTokenStore`.
- Admin: `setSignInUrl` documents how the dashboard (1.0.0-beta.23) sends users back after the host's sign-in: `{returnTo}` in the URL, or a `returnTo=` parameter, to open again with `#token=`.
- **Data explorer: names with capitals just work.** When a read-only SQL source answers that a table or column does not exist because the query wrote it without quotes (PostgreSQL folds such names to lower case: `SELECT count(*) FROM Users` looks for `users`), the query runs again with the name as the schema spells it, quoted the source's way: `"Users"` (PostgreSQL, SQLite), `[Users]` (SQL Server with a case-sensitive collation), `` `Users` `` (MySQL on a case-sensitive file system). The result's new `executedQuery` shows the query that ran, and the audit entry keeps both. Only a name that matches exactly one table the source shows or column it does not drop is changed, never inside strings or comments, nor a function name (`count(`). Off with `fixNameCase: false` on the source options; writable sources (`readOnly: false`) are never run twice. Providers quote with `IDataExplorerProvider.quoteName` (default ANSI double quotes). When nothing can be fixed, the error adds the hint `Names with capital letters need double quotes: "Users"`.
- **Command modules on the Plugins page for commands registered on their own.** Commands added with `addProcessor(...)` are listed under the module their `module` property names (case-insensitive), and the page's switch disables them too; before, only `addModule` modules were listed. A module with the same name and no processors describes the group (description, version, icon); without one, the group takes its version and author from its first command. `ICliModule.icon` (one emoji or an image URL, default `undefined`) is returned as `icon` by `/api/v1/qcli/plugins` and the new `/api/v1/qcli/plugins/:id` for the dashboard's module cards.

## 1.0.0-beta.26

- The admin plugin embeds dashboard 1.0.0-beta.22: built with Qodalis CLI 2.5.1 (touch scrolling of the terminal page on phones, page no longer scrolls under the panel).

- Fix: data explorer sources with `AllowedObjects` or `MaskColumns` refused ordinary queries on quoted names, such as PostgreSQL's mixed-case tables: `SELECT "Id" FROM "Users" WHERE ...` answered `'WHERE' is not available on this source` (and `FROM "Users" u` named `u`). Under the MySQL reading, where `"..."` is a string, the string was dropped, so the next word was taken as the table. It now stays one name token, so the table is checked by its name, and a quoted masked column in `WHERE` is still refused.

## 1.0.0-beta.25

- The admin plugin embeds dashboard 1.0.0-beta.20: job tags, command metadata, the terminal link page, API tokens, a data explorer page and audit details.

- **Jobs: tags.** `tags` on a job (`CliJobOptions.tags`: free-form labels such as `country:ro`, `bank`; each 1-64
  characters without commas, at most 20, duplicates ignoring case dropped), always present in job info (`[]` when
  none). `GET /api/v1/qcli/jobs?tag=a&tag=b` (repeatable or comma-separated) lists the jobs that have every tag,
  ignoring case; `/executions` and `/stats` take `tag=` too. `PUT /jobs/{id}` accepts `tags` (replaces them, `null`
  clears, invalid ones are 400 `INVALID_VALUE`). MCP `jobs_list` takes `tags` and shows them. Same on the .NET and
  Python servers.
- **Commands as rich as web commands.** Processors may set `aliases`, `examples` (`{ command, description? }`),
  `documentation`, `module` and `icon`, and parameters `allowedValues` and `examples` (example values); `GET /api/v1/qcli/commands` sends them (absent
  when unset), so the web CLI's `help` shows examples and documentation, groups and decorates the command, and completes
  and checks allowed values. The server resolves aliases of commands and sub-commands for `/execute`, streaming and
  permission checks (a command name wins over another command's alias). MCP command tools list allowed values as an
  `enum` (and parameter examples as `examples`) and refuse other values. The built-in processors and the weather plugin carry examples and documentation
  (`hash --algorithm` its algorithms). Same on the .NET and Python servers (spec: web-cli
  `docs/superpowers/specs/2026-11-12-server-command-metadata-design.md`).
- **Data explorer: per-source permissions, read-only mode, masking, audit and limits**, the same on the .NET and Python servers
  (spec: web-cli `docs/superpowers/specs/2026-11-12-data-explorer-hardening-design.md`):
  - **Breaking:** sources are read-only by default. Writes, DDL and several statements are refused before the provider runs
    (`errorCode: 'read_only'`), and the SQL providers run queries in a read-only transaction. Set `readOnly: false` on a source that must write.
    The SQL check reads quotes and comments as MySQL (`--` before a space, `#`, `/*! ... */`, `"..."` strings), Postgres
    (`E'...'`, `$$...$$`, nested comments), SQL Server (nested comments, `[...]`) and SQLite each do, and a query must
    pass under every reading, so a quote or comment one database skips cannot hide a statement another runs. The Postgres
    provider runs one statement per query. `COMMIT`, `ROLLBACK` and `DENY` count as writes, and a lone carriage return is refused.
  - `allowedObjects` reads every item of a SQL `FROM`/`USING` list, `db..table`, `DESCRIBE`/`EXPLAIN <table>`, CTE names only in
    their scope, the collections of MongoDB `$lookup`/`$graphLookup`/`$unionWith`/`$out`/`$merge` (JSON escapes decoded) and
    Elasticsearch indices named in the body; Elasticsearch `POST …/_search` is a read only after index names (the path is
    cut at `?` and `#`); Redis keys are split as the provider splits them. JSON text in results is masked like a document.
  - On SQL sources with `maskColumns` or `dropColumns`, those columns can only be selected by their own name (a plain
    item of the outer select list, or `*`): aliases, expressions, filters, sorts, subqueries, set operations, Postgres
    whole-row values and `U&"..."` names are refused before the query runs (`errorCode: 'masked_column'`, `Masked column
    'email' can only be selected by its own name`), and a result that returns such a column under another name is withheld.
  - New source options: `requiredPermissions` (403, and the source is hidden from `/sources` and MCP `data_sources`),
    `allowedObjects` (globs of tables, collections, keys or indices), `maskColumns` (`***`), `dropColumns`, `audit`
    (default true: a `data_query` audit entry per execute), `rateLimit { maxQueries, windowSeconds }` (429) and `exportPermissions`.
  - `GET /sources` adds `readOnly` and `canExport`; the schema lists only allowed tables without dropped columns; results carry `errorCode` when refused.
  - `DataExplorerExecutor.executeAsync(request, caller?)`, `createDataExplorerController(registry, executor, { caller })`; providers that only read can set `readOnlyQueries`.
- **Link a terminal through the browser** (users plugin), the same on the .NET and Python servers
  (spec: web-cli `docs/superpowers/specs/2026-11-12-server-linking-design.md`): `POST /api/v1/qcli/link` (public,
  rate limited) returns a code and the approval page, `GET /link/{linkId}` hands the terminal its API token once the
  user approved at `/qcli/admin/link?code=…` (`GET /link/code/{code}`, `POST …/approve`, `POST …/deny`). The token is
  the approver's, named `link <client>`, scoped to the requested permissions. `setLinkApprovalUrl` points to a host's
  own page; `link_approved` and `link_denied` are audited.

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
