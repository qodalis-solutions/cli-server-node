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
| `schedule` | `string?` | — | Cron expression (5-field) |
| `interval` | `string?` | — | Fixed interval (`30s`, `5m`, `1h`, `1d`); the next run is the last run plus the interval, across restarts and pauses (right away when that has passed) |
| `runOnStart` | `boolean` | `false` | Run when the scheduler starts unless the job ran recently: an interval job when it never ran or its next run is due, a cron job when it never ran or missed an occurrence since its last run, a job without a schedule on every start. Not for paused or stopped jobs; it takes a run slot like any due run |
| `enabled` | `boolean` | `true` | Whether the job starts active. `false` keeps it stopped whatever state was saved; otherwise a saved pause or stop (made from the API) is kept across restarts |
| `maxRetries` | `number` | `1` | Retry count on failure |
| `timeout` | `string?` | — | Max execution duration (same format as interval); a run past it ends as `timed_out`, a run cancelled by hand as `cancelled` |
| `maxConcurrentRuns` | `number` | `1` | Up to this many runs of the job at the same time (integer >= 1) |
| `overlapPolicy` | `string` | `skip` | What a due run does when `maxConcurrentRuns` runs are going: `skip`, `queue`, or `cancel` (see below) |

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
entry), `currentExecutionId` (the newest of them) and `queued`.

A cron job computes its next occurrence from the one that just fired, so a timer that fires a few milliseconds
early never runs an occurrence twice. On start, runs a previous process left `running` in the store are finished as
`cancelled` with the error `Interrupted: the server stopped during the run`, completed at their last log entry when
it is later than their start, else at their start. No events are published for them.

## REST API

All endpoints are mounted at the plugin's built-in prefix (`/api/v1/qcli/jobs`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all jobs |
| GET | `/executions` | Executions across jobs, newest first: `?job=a,b` (repeatable), `group=`, `status=`, `since=` (ISO 8601), `limit=` (1-100), `offset=` → `{ items, total, limit, offset }` |
| GET | `/stats` | Run statistics for charts: `?since=&until=` (ISO 8601, default the last 24 hours), `buckets=` (1-200, default 24), `job=`, `group=` as in `/executions` → `{ since, until, bucketMs, buckets: [{ start, succeeded, failed, cancelled, running }], totals, jobs }`; `totals` and each job carry counts, `successRate`, `avgDuration`, `p95Duration`, `maxDuration`, `lastFailureAt`, and each job its 12 latest runs (`recent`). Built from every run in the range, read page by page through the storage's execution query, so it works with any storage provider |
| GET | `/:id` | Get job details |
| POST | `/:id/trigger` | Trigger a run → `{ "message": "Job triggered", "queued": false }` once it ran, `{ "message": "Job queued", "queued": true }` when queued; 409 `JOB_ALREADY_RUNNING` when every slot is taken and the policy is `skip` |
| POST | `/:id/pause` | Pause scheduled execution |
| POST | `/:id/resume` | Resume a paused job |
| POST | `/:id/stop` | Stop job: cancel its runs, drop a queued one, disable the schedule |
| POST | `/:id/cancel` | Cancel every running run and drop a queued one; 409 `JOB_NOT_RUNNING` when idle |
| PUT | `/:id` | Update job options: `description`, `group`, `schedule`, `interval`, `maxRetries`, `retryDelay`, `retryStrategy`, `timeout`, `overlapPolicy`, `maxConcurrentRuns` (integer >= 1, else 400 `INVALID_VALUE`) |
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

Besides the required methods, a storage may implement `queryExecutions(query)` (listing across jobs in one query; without it the scheduler merges the per-job listings), `prune(before)` (delete old executions; call it on a schedule, e.g. `pruneJobExecutions(storage, new Date(Date.now() - 30 * 86_400_000))`) and `deleteExecution(id)` (used by `discard()`; without it discarded runs are kept). The in-memory storage implements all three.

## License

MIT
