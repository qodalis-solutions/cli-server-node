# Qodalis CLI Server (Node.js)

Express server that runs server-side commands, files, data sources, jobs and a remote shell for the Qodalis web terminal.

[![npm](https://img.shields.io/npm/v/@qodalis/cli-server-node)](https://www.npmjs.com/package/@qodalis/cli-server-node)
[![npm abstractions](https://img.shields.io/npm/v/@qodalis/cli-server-abstractions?label=abstractions)](https://www.npmjs.com/package/@qodalis/cli-server-abstractions)
[![Build & Test](https://github.com/qodalis-solutions/cli-server-node/actions/workflows/build.yml/badge.svg)](https://github.com/qodalis-solutions/cli-server-node/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`@qodalis/cli-server-node` is the Node.js backend of the [Qodalis CLI](https://cli.qodalis.com/docs). You register command processors (classes with a name, parameters and a handler); the browser terminal discovers them over REST and runs them as if they were local commands. Use it as a library inside an existing Express app or run it standalone.

| Part of the ecosystem | Repository |
|---|---|
| Web terminal (engine, Angular/React/Vue wrappers, plugins) | [qodalis-solutions/web-cli](https://github.com/qodalis-solutions/web-cli) |
| Node.js server (this repo) | [qodalis-solutions/cli-server-node](https://github.com/qodalis-solutions/cli-server-node) |
| .NET server (same API) | [qodalis-solutions/cli-server-dotnet](https://github.com/qodalis-solutions/cli-server-dotnet) |
| Python server (same API) | [qodalis-solutions/cli-server-python](https://github.com/qodalis-solutions/cli-server-python) |
| Admin dashboard served by the admin plugin | [qodalis-solutions/cli-server-dashboard](https://github.com/qodalis-solutions/cli-server-dashboard) |
| MCP bridge for Claude Code | [qodalis-solutions/mcp-cli](https://github.com/qodalis-solutions/mcp-cli) |

## Quick start

```bash
npm install @qodalis/cli-server-node
```

```typescript
import { createCliServer, CliCommandProcessor, CliProcessCommand } from '@qodalis/cli-server-node';

class GreetProcessor extends CliCommandProcessor {
    command = 'greet';
    description = 'Says hello';
    acceptsValue = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return `Hello, ${command.value ?? 'World'}!`;
    }
}

const { app, eventSocketManager } = createCliServer({
    allowedOrigins: ['http://localhost:4200'], // the web app hosting the terminal
    configure: (builder) => builder.addProcessor(new GreetProcessor()),
});

const server = app.listen(8047, () => console.log('CLI server on http://localhost:8047'));
eventSocketManager.attach(server); // WebSockets: events, logs, shell

process.on('SIGINT', async () => {
    await eventSocketManager.broadcastDisconnect();
    server.close();
    process.exit(0);
});
```

Point the web terminal at `http://localhost:8047` and type `greet Alice`.

Run the standalone server instead (built-in processors plus the weather module):

```bash
npx -p @qodalis/cli-server-node qodalis-cli-server
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8047` | Listening port |
| `QCLI_ALLOWED_ORIGINS` | none | Comma-separated origins allowed for CORS and WebSockets |
| `QCLI_SHELL_TOKEN` | none | Enables the remote shell in token mode |

Plugin authors who only need the base types can depend on [`@qodalis/cli-server-abstractions`](packages/abstractions/README.md) (zero dependencies).

## Features

- Command processors with typed parameters, aliases, defaults, sub-commands and modules
- Plain-text or structured output (tables, lists, JSON, key-value) and SSE streaming execution
- Versioned REST API compatible with the .NET and Python servers
- File storage API with pluggable backends (memory, OS, JSON, SQLite, S3)
- Data explorer over SQL, PostgreSQL, MySQL, SQL Server, MongoDB, Redis and Elasticsearch
- Background jobs, admin dashboard, users, groups, permissions and API tokens as plugins
- Remote PTY shell with explicit access modes, limits and process-tree cleanup
- MCP endpoint that exposes commands, files, data and jobs as tools to AI clients
- Origin checks, CORS allow-list and trusted-proxy handling

## Writing commands

### Processors and parameters

```typescript
import { CliCommandProcessor, CliCommandParameterDescriptor, CliProcessCommand } from '@qodalis/cli-server-node';

class TimeProcessor extends CliCommandProcessor {
    command = 'time';
    description = 'Shows the current server time';
    parameters = [
        //                               name     description       required type       aliases
        new CliCommandParameterDescriptor('utc', 'Show UTC time', false, 'boolean'),
        new CliCommandParameterDescriptor('format', 'Output format', false, 'string', ['-f'], 'ISO'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const now = new Date();
        return command.args?.utc ? now.toISOString() : now.toLocaleString();
    }
}
```

Nest processors with `processors = [new AddProcessor(), new MultiplyProcessor()]` to get `math add --a 1 --b 2`. Implement `handleStructuredAsync` instead of `handleAsync` to return typed outputs.

| Member | Default | Description |
|---|---|---|
| `command`, `description` | required | Name and help text |
| `handleAsync(command, signal?)` | required | Execution logic, returns text |
| `handleStructuredAsync(command, signal?)` | none | Returns `{ exitCode, outputs }`; takes precedence over `handleAsync` |
| `parameters` | none | `CliCommandParameterDescriptor[]` (`string`, `number`, `boolean`, ...) |
| `processors` | none | Sub-commands |
| `allowUnlistedCommands` | none | Accept sub-commands not listed in `processors` |
| `valueRequired` / `acceptsValue` | none | Positional value is required / optional (MCP exposes it as `value`) |
| `requiredPermissions` | none | Enforced server-side when the users plugin is mounted |
| `version`, `author` | `'1.0.0'`, library author | Metadata |

### Command input

| Property | Description |
|---|---|
| `command` | Command name |
| `value` | Positional text as typed (quotes included) |
| `positionals` | Positional arguments split like a shell (sent by newer clients) |
| `args` | Named parameters (`--format "HH:mm"`) |
| `chainCommands` | Sub-command chain (`["add"]` in `math add`) |
| `rawCommand` | Original input |
| `data` | Arbitrary payload from the client |

Read positional input with `getPositionals(command)` or `getPositionalText(command)`; both fall back to splitting `value` with `splitShellWords`, so quotes never leak into what a processor reads.

### Modules

```typescript
import { CliModule, ICliCommandProcessor } from '@qodalis/cli-server-node';

export class WeatherModule extends CliModule {
    name = 'weather';
    version = '1.0.0';
    description = 'Weather commands';
    processors: ICliCommandProcessor[] = [new WeatherProcessor()];
}

createCliServer({ configure: (builder) => builder.addModule(new WeatherModule()) });
```

`plugins/weather/` is a complete reference module (`weather`, `weather current`, `weather forecast`).

## Configuration

`createCliServer(options)`:

| Option | Default | Description |
|---|---|---|
| `basePath` | `'/api/qcli'` | Extra mount point for the CLI routes; also sets the MCP path (`{basePath}/mcp`) |
| `allowedOrigins` | none | CORS and WebSocket `Origin` allow-list (`http://host:*` matches any port) |
| `cors` | from `allowedOrigins` | `true` (any origin), `false`, or a `cors` options object |
| `trustProxy` | `false` | Number of trusted reverse-proxy hops for `X-Forwarded-*` (`true` = 1) |
| `enableShell` | `false` | Accept remote shell sessions (see [Remote shell](#remote-shell)) |
| `shell` | none | Shell access mode, limits, timeouts, `cwd`, `env` |
| `auth` | none | Auth provider protecting the whole server (for example `usersPlugin.serverAuth`) |
| `mcp` | off | `true` or `{ tools, exclude, token, instructions, enabled }` (see [MCP](#mcp-endpoint)) |
| `configure` | none | `(builder) => ...` to register processors, modules, storage and data sources |

`configure` receives a `CliBuilder`: `addProcessor`, `addModule`, `setFileStorageProvider`, `addFileSystem`, `addDataExplorerProvider`, `addMcpToolProvider` (all chainable).

`createCliServer` returns:

| Field | Description |
|---|---|
| `app` | The Express app |
| `registry`, `builder`, `executor` | Processor registry, registration builder, command executor |
| `eventSocketManager` | `attach(server)` for the WebSockets, `broadcastMessage`, `broadcastDisconnect` |
| `logSocketManager` | Server log stream socket |
| `mountPlugin(plugin)` | Mounts a plugin's routes (and dashboard, MCP providers, server auth) |
| `setAuth(auth)` | Installs or removes the server auth provider |
| `mcp` | `{ enabled, path, addProvider(provider) }` |

Same-origin requests (such as the admin dashboard at `/qcli/admin`) always pass the Origin, CORS and CSRF checks. With `trustProxy` set to n hops, the client IP is the `X-Forwarded-For` entry at index `len - n`; set it to the exact number of proxies you run, otherwise clients can spoof their address.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/qcli/versions` | Supported API versions and the preferred one |
| GET | `/api/v1/qcli/version` | Server version |
| GET | `/api/v1/qcli/capabilities` | OS, shell availability (`shell`, `shellAuth`), streaming, version |
| GET | `/api/v1/qcli/commands` | Registered processors |
| POST | `/api/v1/qcli/execute` | Execute a command |
| POST | `/api/v1/qcli/execute/stream` | Execute with Server-Sent Events output |
| GET | `/api/qcli/fs/ls`, `cat`, `stat`, `download` | File storage (when a provider is configured) |
| POST | `/api/qcli/fs/upload`, `mkdir` | Upload (multipart) / create directory |
| DELETE | `/api/qcli/fs/rm` | Delete file or directory |
| GET | `/api/qcli/data-explorer/sources`, `schema` | Data sources and their schema (when sources are registered) |
| POST | `/api/qcli/data-explorer/execute` | Run a query against a source |
| POST | `/api/qcli/mcp` | MCP endpoint (when `mcp` is enabled) |
| WS | `/ws/v1/qcli/events` | Server-push events |
| WS | `/ws/v1/qcli/logs` | Server log stream |
| WS | `/ws/v1/qcli/shell` | Interactive PTY shell (when `enableShell` is on) |

Every WebSocket is also served without the version (`/ws/qcli/events`, ...). Plugins add their own routes: users (`/api/v1/qcli/sessions`, `/users`, `/groups`, `/tokens`, ...), jobs and admin; see their READMEs.

## Plugins

| Package | Description |
|---|---|
| [`@qodalis/cli-server-plugin-users`](plugins/users/README.md) | Users, groups, permissions, sessions, API tokens, audit log; protects the whole server |
| [`@qodalis/cli-server-plugin-admin`](plugins/admin/README.md) | Admin dashboard at `/qcli/admin` (status, configuration, logs) |
| [`@qodalis/cli-server-plugin-jobs`](plugins/jobs/README.md) | Cron and interval background jobs with history and REST management |
| [`@qodalis/cli-server-plugin-filesystem`](plugins/filesystem/README.md) | File storage abstraction with in-memory and OS providers |
| [`-filesystem-json`](plugins/filesystem-json/README.md), [`-filesystem-sqlite`](plugins/filesystem-sqlite/README.md), [`-filesystem-s3`](plugins/filesystem-s3/README.md) | JSON file, SQLite and Amazon S3 storage providers |
| [`@qodalis/cli-server-plugin-data-explorer`](plugins/data-explorer/README.md) | Data explorer core |
| [`-data-explorer-sql`](plugins/data-explorer-sql/README.md), [`-postgres`](plugins/data-explorer-postgres/README.md), [`-mysql`](plugins/data-explorer-mysql/README.md), [`-mssql`](plugins/data-explorer-mssql/README.md), [`-mongo`](plugins/data-explorer-mongo/README.md), [`-redis`](plugins/data-explorer-redis/README.md), [`-elasticsearch`](plugins/data-explorer-elasticsearch/README.md) | Data explorer providers |
| [`@qodalis/cli-server-plugin-aws`](plugins/aws/README.md) | AWS commands: S3, EC2, Lambda, CloudWatch, SNS, SQS, IAM, DynamoDB, ECS |
| [`@qodalis/cli-server-plugin-weather`](plugins/weather/README.md) | Example module |

Builder-based plugins are mounted with `mountPlugin`:

```typescript
import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';

const { app, eventSocketManager, mountPlugin } = createCliServer({ /* ... */ });
const broadcast = (msg: Record<string, unknown>) => eventSocketManager.broadcastMessage(msg);

mountPlugin(new CliJobsBuilder().addJob(new HealthCheckJob(), { name: 'health', interval: '30s' }).build(broadcast));
mountPlugin(new CliUsersBuilder().setDefaultAdminPassword(process.env.ADMIN_PASSWORD!).build(broadcast));
```

### File storage

```typescript
import { OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';

createCliServer({
    configure: (builder) =>
        builder.setFileStorageProvider(new OsFileStorageProvider({ allowedPaths: ['/srv/share'] }), {
            maxUploadBytes: 500 * 1024 * 1024, // default 100 MiB, one file per upload
        }),
});
```

Other providers: `InMemoryFileStorageProvider`, `JsonFileStorageProvider({ filePath })`, `SqliteFileStorageProvider({ dbPath })`, `S3FileStorageProvider({ bucket, region, prefix, credentials })`. Implement `IFileStorageProvider` for your own backend. To mount the router yourself, use `createFilesystemRouter(provider, { maxUploadBytes })`.

### Data explorer

```typescript
import { SqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-sql';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

builder.addDataExplorerProvider(new SqlDataExplorerProvider({ type: 'sqlite', filename: './data.db' }), {
    name: 'app-db',
    description: 'Application database',
    language: DataExplorerLanguage.Sql,
    defaultOutputFormat: DataExplorerOutputFormat.Table,
    timeout: 30000,
    maxRows: 1000,
});
```

The same provider class can be registered several times under different names. Implement `IDataExplorerProvider` for other sources.

## Security

When the users plugin is mounted (`mountPlugin(usersPlugin)`, or passed as `auth`), every `/api/...` route and WebSocket requires a session or an API token; login, version discovery and capabilities stay public.

| Surface | Permission |
|---|---|
| `GET /commands` | authenticated |
| `POST /execute`, `/execute/stream` | `commands:execute` plus the processor's `requiredPermissions` |
| `POST /api/qcli/mcp` | `commands:execute` (each tool then checks its own) |
| fs `ls` / `cat` / `stat` / `download` | `files:read` |
| fs `upload` / `mkdir` / `rm` | `files:write` |
| data explorer | `data:query` |
| jobs read / manage | `jobs:read` / `jobs:manage` |
| events / logs / shell WebSocket | authenticated / `logs:read` / `shell:execute` |
| admin dashboard | `admin:access` |

WebSockets authenticate with a single-use ticket from `POST /api/v1/qcli/sessions/ws-ticket` (`?ticket=<ticket>`). Sockets bound to a session close with 4401 `session ended` on logout, expiry, kick, or when the user is disabled or deleted. Details: [users plugin README](plugins/users/README.md).

### Remote shell

The PTY shell gives OS-level access, so it is off unless `enableShell: true`, and then exactly one access mode applies:

| Mode (`shellAuth`) | When | Client must |
|---|---|---|
| `users` | users plugin mounted | connect with a WS ticket of a session holding `shell:execute` |
| `token` | `shell.token` set | send `Authorization: Bearer <token>` (or the `_header_Authorization` query parameter) |
| `custom` | `shell.authorize` set | pass `authorize(request, { url, remoteAddress, mode })` |
| `anonymous` | `shell.allowAnonymous: true` | nothing (a startup warning is logged) |
| `locked` | none of the above | connections are closed with 4401 |

The users plugin wins when mounted; otherwise `token`, then `custom`, then `anonymous`. Every configured check among `token` and `authorize` must pass. Tokens are compared in constant time and never logged.

```typescript
createCliServer({
    enableShell: true,
    shell: { token: process.env.QCLI_SHELL_TOKEN },
});
```

| `shell` option | Default | Description |
|---|---|---|
| `token`, `authorize`, `allowAnonymous` | none | Access mode (see above) |
| `maxSessionsPerUser` | `3` | Per user (users mode) or per remote address |
| `maxSessions` | `20` | Total concurrent shells |
| `idleTimeoutMs` | 15 min | Close after no stdin (`0` = off) |
| `maxDurationMs` | none | Absolute session limit |
| `sessionCheckIntervalMs` | `30000` | Users-mode re-check (max 60000) |
| `cwd`, `shell` | home dir, detected | Working directory and shell binary |
| `env` | `{}` | `{ allow: string[], set: Record<string, string> }` |

- The shell does not inherit the server environment: it gets `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `COLUMNS`, `LINES`, `SHELL`, plus `env.allow` and `env.set`.
- A shell bound to a users session closes with 4401 when the session ends or `shell:execute` is removed; opens and closes are audited as `shell_opened` / `shell_closed`, never with the command text.
- When a shell ends, its whole process tree is killed (SIGHUP, SIGTERM, then SIGKILL after 1 s): process group, descendants, Linux session, and every process carrying the shell's `QCLI_SHELL_ID` marker. On Windows only the shell process is killed. Run the server in a container if every process must be contained.

| Close code | Reason |
|---|---|
| 4401 | login required, session ended, or shell access not configured |
| 4403 | forbidden (wrong token, `authorize` false, missing `shell:execute`, password change required) |
| 4404 | shell disabled |
| 4408 | shell timed out |
| 4429 | too many shell sessions |
| 1001 | server shutdown |

## MCP endpoint

`POST {basePath}/mcp` (default `/api/qcli/mcp`) exposes the server to AI clients such as Claude Code over the [Model Context Protocol](https://modelcontextprotocol.io): stateless Streamable HTTP with JSON responses, methods `initialize`, `ping`, `tools/list`, `tools/call`. It is off by default.

```typescript
const { mcp } = createCliServer({
    mcp: {
        tools: ['weather_*', 'echo'],     // allow-list (trailing * = prefix); default: every tool
        exclude: ['fs_delete'],           // deny-list applied after `tools`
        token: process.env.MCP_TOKEN,     // only without an auth provider: required bearer token
        instructions: 'Each tool runs one command of this server.',
    },
});
```

| Server setup | Access |
|---|---|
| users plugin mounted | session or API token (`qcli_pat_...`) holding `commands:execute`; tools are filtered by the caller's permissions |
| no auth provider, `mcp.token` set | `Authorization: Bearer <token>` |
| no auth provider, no token | open, like `/execute` |

| Tools | Available when | Permission |
|---|---|---|
| `server_info` | always | none |
| one tool per command (`weather`, `weather_current`, ...) | always | `commands:execute` plus `requiredPermissions` |
| `fs_list`, `fs_stat`, `fs_read` / `fs_write`, `fs_mkdir`, `fs_delete` | file storage configured | `files:read` / `files:write` |
| `data_sources`, `data_schema`, `data_query` | data sources registered | `data:query` |
| `jobs_list`, `jobs_get`, `jobs_history` / `jobs_trigger`, `jobs_pause`, `jobs_resume`, `jobs_stop`, `jobs_cancel` | jobs plugin mounted | `jobs:read` / `jobs:manage` |

Command tools run through the same executor as `/execute`; outputs are rendered as text, `isError` is `exitCode != 0`. Add your own tools with `mcp.addProvider(provider)`, `builder.addMcpToolProvider(provider)` or a plugin's `mcpProviders` (use `mcpObjectSchema` to build the input schema). An `Origin` header, when present, must be allowed or same-origin.

Connect Claude Code (with the users plugin, create a token with `token create claude` in the web CLI or `POST /api/v1/qcli/tokens`):

```bash
# directly over HTTP
claude mcp add --transport http qcli http://localhost:8047/api/qcli/mcp --header "Authorization: Bearer <token>"

# or through the @qodalis/mcp-cli bridge
claude mcp add qcli -e QCLI_URL=http://localhost:8047 -e QCLI_TOKEN=<token> -- npx -y @qodalis/mcp-cli
```

| Symptom | Fix |
|---|---|
| `401` | Missing, wrong, expired or revoked token; without the users plugin check `mcp.token` |
| `403 forbidden: origin not allowed` | Add the client's origin to `allowedOrigins` (Claude Code sends none) |
| `403 forbidden: missing permission commands:execute` | Grant it to one of the user's groups or the token's scope |
| `404` | MCP is not enabled or the URL is not `{basePath}/mcp` |
| `405` | Only `POST` is accepted |
| Tool missing from `tools/list` | Missing permission, filtered by `tools`/`exclude`, or the feature is not enabled |

## Built-in processors

| Command | Description |
|---|---|
| `echo` | Echoes input text |
| `status` | Server status (uptime, OS) |
| `system` | System information (memory, CPU, uptime) |
| `http` | HTTP `get` / `post` requests |
| `hash` | MD5, SHA1, SHA256, SHA512 |
| `base64` | `encode` / `decode` |

All are exported (`CliEchoCommandProcessor`, `CliStatusCommandProcessor`, ...) and registered by the standalone server.

## Docker

```bash
docker run -p 8047:8047 ghcr.io/qodalis-solutions/cli-server-node
```

The image runs the standalone server and accepts the same environment variables. `docker-compose.yml` builds and runs the demo server (`demo/Dockerfile`) on port 8047.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest run
npm run test:watch   # vitest in watch mode
npm run dev          # standalone server with watch (tsx)

cd demo && npm install && npm start   # full demo: all plugins, users (root / admin), MCP, shell
```

| Path | Contents |
|---|---|
| `src/` | Server factory, controllers, services, MCP, built-in processors, standalone entry (`server.ts`) |
| `packages/abstractions/` | `@qodalis/cli-server-abstractions` |
| `plugins/` | Plugin packages (users, admin, jobs, filesystem, data explorer, aws, weather) |
| `demo/` | Demo server with custom processors and every plugin |

## License

[MIT](LICENSE)
