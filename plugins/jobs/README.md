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
| `runOnStart` | `boolean` | `false` | Run once right after the scheduler starts (not for paused or stopped jobs) |
| `enabled` | `boolean` | `true` | Whether the job starts active. `false` keeps it stopped whatever state was saved; otherwise a saved pause or stop (made from the API) is kept across restarts |
| `maxRetries` | `number` | `0` | Retry count on failure |
| `timeout` | `string?` | — | Max execution duration (same format as interval) |
| `overlapPolicy` | `string` | `skip` | `skip`, `queue`, or `cancel` |

## REST API

All endpoints are mounted at the plugin's built-in prefix (`/api/v1/qcli/jobs`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all jobs |
| GET | `/executions` | Executions across jobs, newest first: `?job=a,b` (repeatable), `group=`, `status=`, `since=` (ISO 8601), `limit=` (1-100), `offset=` → `{ items, total, limit, offset }` |
| GET | `/stats` | Run statistics for charts: `?since=&until=` (ISO 8601, default the last 24 hours), `buckets=` (1-200, default 24), `job=`, `group=` as in `/executions` → `{ since, until, bucketMs, buckets: [{ start, succeeded, failed, cancelled, running }], totals, jobs }`; `totals` and each job carry counts, `successRate`, `avgDuration`, `p95Duration`, `maxDuration`, `lastFailureAt`, and each job its 12 latest runs (`recent`). Built from every run in the range, read page by page through the storage's execution query, so it works with any storage provider |
| GET | `/:id` | Get job details |
| POST | `/:id/trigger` | Trigger immediate execution |
| POST | `/:id/pause` | Pause scheduled execution |
| POST | `/:id/resume` | Resume a paused job |
| POST | `/:id/stop` | Stop job and cancel if running |
| POST | `/:id/cancel` | Cancel current execution only |
| PUT | `/:id` | Update job options |
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
