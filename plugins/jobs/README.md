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
    .build((msg) => eventSocketManager.broadcastMessage(msg));

// Using createCliServer:
mountPlugin(jobsPlugin);

// Or on an existing Express app:
app.use(jobsPlugin.prefix, jobsPlugin.router);

await jobsPlugin.scheduler.start();
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string?` | Class name | Job display name |
| `description` | `string?` | Name | Human-readable description |
| `group` | `string?` | — | Logical grouping |
| `schedule` | `string?` | — | Cron expression (5-field) |
| `interval` | `string?` | — | Fixed interval (`30s`, `5m`, `1h`, `1d`) |
| `enabled` | `boolean` | `true` | Whether the job starts active |
| `maxRetries` | `number` | `0` | Retry count on failure |
| `timeout` | `string?` | — | Max execution duration (same format as interval) |
| `overlapPolicy` | `string` | `skip` | `skip`, `queue`, or `cancel` |

## REST API

All endpoints are mounted at the plugin's built-in prefix (`/api/v1/qcli/jobs`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all jobs |
| GET | `/:id` | Get job details |
| POST | `/:id/trigger` | Trigger immediate execution |
| POST | `/:id/pause` | Pause scheduled execution |
| POST | `/:id/resume` | Resume a paused job |
| POST | `/:id/stop` | Stop job and cancel if running |
| POST | `/:id/cancel` | Cancel current execution only |
| PUT | `/:id` | Update job options |
| GET | `/:id/history` | Paginated execution history |
| GET | `/:id/history/:execId` | Execution detail with logs |

## Custom Storage

By default, execution history is stored in memory. Provide a custom `ICliJobStorageProvider` for persistence:

```typescript
const plugin = new CliJobsBuilder()
    .setStorageProvider(new MyDatabaseStorageProvider())
    .addJob(new HealthCheckJob(), { name: 'health-check', interval: '30s' })
    .build();
```

## License

MIT
