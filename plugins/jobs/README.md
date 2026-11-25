# @qodalis/cli-server-plugin-jobs

Background job scheduling plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Provides cron and interval-based job scheduling, execution history, retry policies, and a REST API for management.

## Install

```bash
npm install @qodalis/cli-server-plugin-jobs
```

## Quick Start

1. Implement `ICliJob`:

```typescript
import { ICliJob, ICliJobExecutionContext } from '@qodalis/cli-server-abstractions';

export class HealthCheckJob implements ICliJob {
    async executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void> {
        context.logger.info('Running health check...');
        // your logic here
        context.logger.info('Health check passed');
    }
}
```

2. Build the plugin and mount it:

```typescript
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';

const jobsPlugin = new CliJobsBuilder()
    .addJob(new HealthCheckJob(), {
        name: 'health-check',
        description: 'Periodic health check',
        group: 'monitoring',
        tags: ['health', 'nightly'],
        interval: '30s',
    })
    .build(); // mountPlugin hands it the server's event bus; or build(eventBus)

// Using createCliServer:
mountPlugin(jobsPlugin);

// Or on an existing Express app:
app.use(jobsPlugin.prefix, jobsPlugin.router);

await jobsPlugin.scheduler.start();
```

## Events

Job events are published on the server's event bus (`createCliServer().eventBus`) with audience `jobs:read`, and
reach the events WebSocket as flat messages (`{ "type": "job:completed", "timestamp": "…", "jobId", "executionId", "duration" }`):

| Type | Fields | Published by |
|---|---|---|
| `job:started` | jobId, executionId | scheduler |
| `job:completed` | jobId, executionId, duration | scheduler |
| `job:failed` | jobId, executionId, error | scheduler |
| `job:cancelled`, `job:timed_out` | jobId, executionId | scheduler |
| `job:retrying` | jobId, executionId, attempt, maxRetries, delayMs | scheduler |
| `job:paused`, `job:resumed`, `job:stopped` | jobId, status (`paused`, `active`, `stopped`) | scheduler |
| `job:triggered` | jobId | REST API (`POST /:id/trigger`) and MCP `jobs_trigger` |
| `job:updated` | jobId | REST API (`PUT /:id`) |
| `job:runs-deleted` | jobId, executionId (one run) or count (bulk) | REST API and MCP `jobs_delete_runs` |

`build()` takes the bus, or a function broadcasting raw messages (kept for compatibility; the plugin then keeps it).
Built with neither, the plugin gets the server's bus from `mountPlugin` (`jobsPlugin.setEventBus(bus)`). The
scheduler's `setEventBus(bus)`, `eventBus` and `publishEvent(type, data)` are public, for hosts with their own API.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | `string?` | Name | Stable id for the API, history and saved state (`name-2`, `name-3`, ... for duplicate names; a duplicate explicit id throws) |
| `name` | `string?` | Class name | Job display name |
| `description` | `string?` | Name | Human-readable description |
| `group` | `string?` | — | Logical grouping |
| `tags` | `string[]?` | `[]` | Free-form labels to filter jobs by (`country:ro`, `bank`): each 1-64 characters without commas, at most 20, trimmed, duplicates (ignoring case) dropped. Job info always carries `tags` |
| `schedule` | `string?` | — | Cron expression (5-field) |
| `interval` | `string?` | — | Fixed interval (`30s`, `5m`, `1h`, `1d`); the next run is the last run plus the interval, across restarts and pauses (right away when that has passed) |
| `runOnStart` | `boolean` | `false` | Run when the scheduler starts unless the job ran recently: an interval job when it never ran or its next run is due, a cron job when it never ran or missed an occurrence since its last run, a job without a schedule on every start. Not for paused or stopped jobs; it takes a run slot like any due run |
| `enabled` | `boolean` | `true` | Whether the job starts active. `false` keeps it stopped whatever state was saved; otherwise a saved pause or stop (made from the API) is kept across restarts |
| `maxRetries` | `number` | `1` | Retry count on failure |
| `timeout` | `string?` | — | Max execution duration (same format as interval); a run past it ends as `timed_out`, a run cancelled by hand as `cancelled` |
| `maxConcurrentRuns` | `number` | `1` | Up to this many runs of the job at the same time (integer >= 1) |
| `overlapPolicy` | `string` | `skip` | What a due run does when `maxConcurrentRuns` runs are going: `skip`, `queue`, or `cancel` (see below) |
| `history` | `object?` | — | This job's history limits (`maxAge`, `maxRunsPerJob`, `failedMaxAge`, `failedMaxRunsPerJob`), replacing the global ones field by field, or `keepAll: true` to keep every run (see [History retention](#history-retention)) |

## History retention

The scheduler keeps every run unless history retention is configured (opt-in, off by default). Set it on the plugin:

```typescript
const jobsPlugin = new CliJobsBuilder({
    history: {
        maxAge: '30d',            // delete runs older than this
        maxRunsPerJob: 500,       // keep at most this many runs per job (the newest)
        failedMaxAge: '90d',      // optional: failed runs kept longer
        failedMaxRunsPerJob: 100, // optional: failed runs counted on their own
        pruneInterval: '6h',      // how often to prune (default 1 day)
    },
})
    .addJob(new FetchJob(), { name: 'fetch', interval: '30m', history: { maxRunsPerJob: 50 } })
    .addJob(new ReportJob(), { name: 'monthly-report', schedule: '0 0 1 * *', history: { keepAll: true } })
    .build();
```

`setHistory({ ... })` on the builder does the same, and `new CliJobScheduler(storage, { history })` for a scheduler
of your own. Durations are interval strings (`30s`, `5m`, `6h`, `30d`) or milliseconds; counts are integers >= 1;
an invalid value throws when the plugin is built or the job registered.

- A run is deleted when it breaks any limit that is set. Failed runs (status `failed`) use `failedMaxAge` and
  `failedMaxRunsPerJob` when set, else `maxAge` and `maxRunsPerJob`. With `failedMaxRunsPerJob`, failed runs are
  counted on their own and the other runs against `maxRunsPerJob`; without it every run counts against `maxRunsPerJob`.
- A job's own `history` replaces the global limits field by field; `keepAll: true` keeps every run of the job.
- Running runs and the latest run of each job are never deleted. Runs of jobs no longer registered follow the global limits.
- Pruning is the built-in job `jobs:prune-history` (group `system`, tag `system`, every `pruneInterval`, and on start when it never ran or its next run is due), registered
  only when some retention is configured (globally or on a job). Each run records how many runs it deleted in its
  `deleted` property and its log. It can be paused, resumed and triggered like any job; its own history follows the
  global limits. `scheduler.pruneHistoryAsync()` prunes once from the host's code.

Job info (`GET /`, `GET /:id`, MCP `jobs_list` / `jobs_get`) carries the limits that apply to each job as
`historyRetention`, or `null` when none do:

```json
{ "maxAge": "30d", "maxRunsPerJob": 50, "failedMaxAge": "90d", "failedMaxRunsPerJob": null, "overridden": true, "keepAll": false }
```

### Changing the retention at runtime

The plugin result carries the `jobs` [config provider](../../README.md#config-providers) (`configProviders`, registered
by `mountPlugin`): section `history` with `maxAge`, `maxRunsPerJob`, `failedMaxAge`, `failedMaxRunsPerJob`
(durations such as `30d`, counts >= 1; empty keeps every run) and `pruneInterval` (read-only). A change applies to the
next prune (`scheduler.setHistoryDefaults(limits)`, which also registers and starts `jobs:prune-history` when no
retention was set before) and is kept in the server's config store, so it survives a restart with a file, database or
Redis store. Jobs with their own `history` options keep them. `new CliJobsBuilder().setConfigStore(store)` gives the
provider a store of its own instead of the server's default one (the host's `config.stores.jobs` still wins).

```text
config set jobs.history.maxAge 30d
```

## Concurrent runs

A **run** holds one of the job's `maxConcurrentRuns` slots from its start until it ends, its retries and the delays
between them included, so a timer tick or a trigger during a retry delay never starts a second run. Taking a slot is
atomic: due runs at the same moment (timer ticks, triggers, the run on start) never exceed the limit. When the job
is full, the overlap policy decides:

- `skip`: the due run is dropped; a trigger answers 409 `JOB_ALREADY_RUNNING`.
- `queue`: one run is queued and starts when a slot frees. Queued runs coalesce: several due runs while full make
  one more run, not a backlog. A trigger answers `{ "message": "Job queued", "queued": true }`.
- `cancel`: the oldest running run is cancelled, and the new run starts once that run has ended, so the limit is
  never exceeded. Meanwhile the job is `queued`, and further due runs merge into the waiting one.

Lowering `maxConcurrentRuns` cancels nothing: new runs start once the count is below the limit; raising it starts a
queued run. `POST /:id/cancel` cancels every running run and drops a queued one; `stop` does the same and disables
the schedule; a run cancelled by hand ends as `cancelled`, never `timed_out`. Job info carries `maxConcurrentRuns`,
`runningExecutionIds` (the attempts executing now, oldest first; a run in its retry delay keeps its slot without an
entry), `currentExecutionId` (the newest of them, `null` when nothing is executing) and `queued`.

A cron job computes its next occurrence from the one that just fired, so a timer that fires a few milliseconds
early never runs an occurrence twice. On start, runs a previous process left `running` in the store are finished as
`cancelled` with the error `Interrupted: the server stopped during the run`, completed at their last log entry when
it is later than their start, else at their start. No events are published for them.

## REST API

All endpoints are mounted at the plugin's built-in prefix (`/api/v1/qcli/jobs`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List the jobs; `?tag=a&tag=b` (repeatable or comma-separated) lists only those that have every tag, ignoring case |
| GET | `/executions` | Executions across jobs, newest first: `?job=a,b` (repeatable), `group=`, `tag=` (as in `/`), `status=`, `since=` (ISO 8601), `limit=` (1-100), `offset=` → `{ items, total, limit, offset }` |
| GET | `/stats` | Run statistics for charts: `?since=&until=` (ISO 8601, default the last 24 hours), `buckets=` (1-200, default 24), `job=`, `group=`, `tag=` as in `/executions` → `{ since, until, bucketMs, buckets: [{ start, succeeded, failed, cancelled, running }], totals, jobs }`; `totals` and each job carry counts, `successRate`, `avgDuration`, `p95Duration`, `maxDuration`, `lastFailureAt`, and each job its 12 latest runs (`recent`: `{ id, status, startedAt, duration }`, `id` being the execution id for `GET /:id/history/:execId`). Built from every run in the range, read page by page through the storage's execution query, so it works with any storage provider |
| GET | `/:id` | Get job details |
| POST | `/:id/trigger` | Trigger a run; answers at once, without waiting for it to finish: `{ "ok": true, "message": "Job triggered", "queued": false }`, or `{ "ok": true, "message": "Job queued", "queued": true }` when queued; 409 `JOB_ALREADY_RUNNING` when every slot is taken and the policy is `skip` |
| POST | `/:id/pause` | Pause scheduled execution |
| POST | `/:id/resume` | Resume a paused job |
| POST | `/:id/stop` | Stop job: cancel its runs, drop a queued one, disable the schedule |
| POST | `/:id/cancel` | Cancel every running run and drop a queued one; 409 `JOB_NOT_RUNNING` when idle |
| PUT | `/:id` | Update job options: `description`, `group`, `tags` (replaces them; `null` clears; invalid tags are 400 `INVALID_VALUE`), `schedule`, `interval`, `maxRetries`, `retryDelay`, `retryStrategy`, `timeout`, `overlapPolicy`, `maxConcurrentRuns` (integer >= 1, else 400 `INVALID_VALUE`) |
| GET | `/:id/history` | Paginated execution history |
| GET | `/:id/history/:execId` | Execution detail with logs |
| DELETE | `/:id/history/:execId` | Delete one run and its logs → `{ message: "Run deleted" }`; 404 `JOB_NOT_FOUND` / `EXECUTION_NOT_FOUND` (missing or another job's run), 409 `EXECUTION_RUNNING`, 501 `NOT_SUPPORTED` (the storage has no `deleteExecution`) |
| DELETE | `/:id/history` | Delete every finished run of the job, or only those with `?status=` (e.g. `failed`, as in the history filter) → `{ deleted: <count> }`; running runs are never deleted; 404 and 501 as above |

## Inside a job

The execution context has a `logger`, the run's own `properties` (saved with the execution whatever its outcome, returned by the history API, `/executions` and the `jobs_history` MCP tool) and `discard()`, which leaves a completed run out of the history (a frequent job that found nothing to do; failed runs are always kept):

```typescript
class DigestJob implements ICliJob {
    async executeAsync(context: ICliJobExecutionContext, signal: AbortSignal) {
        const due = await findDueDigests();
        if (due.length === 0) return context.discard();
        context.properties.sent = await sendAll(due, signal);
    }
}
```

`plugin.scheduler` (`ICliJobScheduler`) is for the host's own code: `jobs` (the registrations by id), `triggerAsync`, `pauseAsync`, `resumeAsync`, `stopJobAsync`, `cancelCurrentAsync`, `updateOptionsAsync`, `queryExecutions`, `deleteExecutionAsync` and `deleteExecutionsAsync` (the delete endpoints above; the bulk delete pages through the job's runs and deletes each finished one, the default `deleteFinishedJobExecutions` gives other schedulers).

## Custom Storage

By default, execution history is stored in memory. Provide a custom `ICliJobStorageProvider` for persistence (implement the optional `deleteExecution` so runs can be deleted, and so `context.discard()` works; without it the delete endpoints answer 501):

```typescript
const plugin = new CliJobsBuilder()
    .setStorageProvider(new MyDatabaseStorageProvider())
    .addJob(new HealthCheckJob(), { name: 'health-check', interval: '30s' })
    .build();
```

Besides the required methods, a storage may implement `queryExecutions(query)` (listing across jobs in one query; without it the scheduler merges the per-job listings), `pruneHistory(retention)` (the [history retention](#history-retention): per job, delete the runs past its age or count limits, never a running run or the job's newest run; database storages should delete set-based, e.g. the runs not among the newest N, `selectRunsBreakingRetention` does it for runs held in memory), `prune(before)` (delete the executions started before a date; the history retention falls back to it when `pruneHistory` is missing and every job has an age limit) and `deleteExecution(id)` (used by `discard()`; without it discarded runs are kept), and `summarizeExecutions(since, jobIds?)` (per job and status, the number of runs started since a time and the start of the newest one, without loading the runs; database storages use a `GROUP BY`; without it `summarizeJobExecutions(storage, since, jobIds)` reads the runs a page at a time and groups them). The in-memory storage implements all five.

Lists may leave the log entries out: `JobExecutionQuery.includeLogs` (default false) asks for them, and a storage that leaves them out sets `logCount` on each run (the API's `logCount` uses it). `getExecution` returns one run with its logs; the run detail endpoint, `server jobs logs` and the dashboard read logs through it, and the scheduler asks for the logs of the runs it finishes after a restart. The in-memory storage keeps the logs in its lists.

## Dashboard page

The admin dashboard's Jobs page is `@qodalis/cli-dashboard-module-jobs`, copied into this package at build
(`dashboard/`, `npm run copy-dashboard`: the sibling `cli-server-dashboard/modules/jobs/dist`, else the npm
package) and served at `/qcli/modules/jobs` (outside the API, so the dashboard loads it without a token); it shows for
users with `jobs:read`. The page also brings the Overview's job cards (active jobs, runs of the last 24 hours, failing jobs under "Needs attention") and command palette entries (jump to a job, search the jobs). `new CliJobsBuilder().setDashboardDir(dir)` serves another build, `setDashboardDir(false)` leaves the page out.

## Terminal commands

The plugin has no server-side command: the web CLI plugin [`@qodalis/cli-server-jobs`](https://www.npmjs.com/package/@qodalis/cli-server-jobs)
drives its REST API as `server jobs`. Permissions on a protected server: `jobs:read` for reading, `jobs:manage` for
changes.

| Command | Permission | Does |
|---|---|---|
| `server jobs list` (`ls`) | `jobs:read` | Jobs of every connected server (`--group`, `--tag`) |
| `server jobs info <name\|id>` | `jobs:read` | Schedule, retries, timeout, overlap policy, current and last run |
| `server jobs history <name\|id>` | `jobs:read` | Past runs: status, start, duration, attempt, error |
| `server jobs runs [--job <id>] [--status failed] [-n 20]` | `jobs:read` | The latest runs of every job, newest first (`GET /executions`) |
| `server jobs stats` | `jobs:read` | Runs of the last 24 hours: outcomes, success rate, average and p95 duration, per job (`GET /stats`) |
| `server jobs logs <name\|id>` | `jobs:read` | Log entries of the latest run, or of one run |
| `server jobs watch` | `jobs:read` | Job events live (Ctrl+C stops) |
| `server jobs trigger <name\|id>` | `jobs:manage` | Runs a job now |
| `server jobs pause <name\|id>`, `server jobs resume <name\|id>` | `jobs:manage` | Takes a job off its schedule, puts it back |
| `server jobs stop <name\|id>`, `server jobs cancel <name\|id>` | `jobs:manage` | Stops the job (schedule off, run cancelled), or cancels only the run in progress |
| `server jobs edit <name\|id>` | `jobs:manage` | Edits description, group, tags, schedule, retries, timeout, overlap policy |
| `server jobs history clear <name\|id> [--status failed] [--yes]` | `jobs:manage` | Deletes the finished runs of a job (`DELETE /{id}/history`); asks unless `--yes` |
| `server jobs history rm <name\|id> <run-id> [--yes]` | `jobs:manage` | Deletes one run (`DELETE /{id}/history/{execId}`); asks unless `--yes` |

History retention is also a setting: `config get jobs` / `config set jobs.history.<key> <value>` (core `config` command).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install jobs`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) builds the scheduler with the server's event bus and mounts it (API, MCP tools, dashboard page). Its settings are its own `jobs` config provider (run history retention).


The jobs themselves come from code (other plugins, the host): installed alone it runs the history prune job. Runs are
kept in memory; a storage provider needs the builder in code.

## License

MIT
