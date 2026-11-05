# Change Log

Notable changes to the Node CLI server packages (`@qodalis/cli-server-node`, `@qodalis/cli-server-abstractions`,
`@qodalis/cli-server-plugin-*`). Every package shares one version with the .NET and Python servers.

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
