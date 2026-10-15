# Qodalis CLI Server (Node.js)

[![npm @qodalis/cli-server-node](https://img.shields.io/npm/v/@qodalis/cli-server-node?label=%40qodalis%2Fcli-server-node)](https://www.npmjs.com/package/@qodalis/cli-server-node)
[![npm @qodalis/cli-server-abstractions](https://img.shields.io/npm/v/@qodalis/cli-server-abstractions?label=%40qodalis%2Fcli-server-abstractions)](https://www.npmjs.com/package/@qodalis/cli-server-abstractions)

A Node.js CLI server framework for the [Qodalis CLI](https://github.com/qodalis-solutions/web-cli) ecosystem. Build custom server-side commands that integrate with the Qodalis web terminal.

## Installation

```bash
npm install @qodalis/cli-server-node
```

The package exports all types, interfaces, base classes, and built-in processors. TypeScript declarations are included.

### Plugin Authors

If you're building a command processor plugin and don't need the server runtime (Express, WebSocket), install the abstractions package instead:

```bash
npm install @qodalis/cli-server-abstractions
```

This gives you `CliCommandProcessor`, `CliProcessCommand`, `CliCommandParameterDescriptor`, and all other base types with **zero dependencies**. See [`@qodalis/cli-server-abstractions`](https://www.npmjs.com/package/@qodalis/cli-server-abstractions) for details.

## Quick Start

### As a Library

```typescript
import {
    createCliServer,
    CliCommandProcessor,
    CliProcessCommand,
} from '@qodalis/cli-server-node';

class GreetProcessor extends CliCommandProcessor {
    command = 'greet';
    description = 'Says hello';

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const name = command.value ?? 'World';
        return `Hello, ${name}!`;
    }
}

const { app, eventSocketManager } = createCliServer({
    configure: (builder) => {
        builder.addProcessor(new GreetProcessor());
    },
});

const server = app.listen(8047, () => {
    console.log('CLI server listening on http://localhost:8047');
});

eventSocketManager.attach(server);

process.on('SIGINT', async () => {
    await eventSocketManager.broadcastDisconnect();
    server.close();
    process.exit(0);
});
```

### As a Standalone Server

```bash
npx qodalis-cli-server
```

Or with environment variables:

```bash
PORT=9000 npx qodalis-cli-server
```

## Creating Custom Command Processors

### Simple Command

Extend `CliCommandProcessor` and implement `command`, `description`, and `handleAsync`:

```typescript
import { CliCommandProcessor, CliProcessCommand } from '@qodalis/cli-server-node';

class EchoProcessor extends CliCommandProcessor {
    command = 'echo';
    description = 'Echoes input text back';

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return command.value ?? 'Usage: echo <text>';
    }
}
```

Register it during server creation:

```typescript
const { app, eventSocketManager } = createCliServer({
    configure: (builder) => {
        builder
            .addProcessor(new EchoProcessor())
            .addProcessor(new AnotherProcessor()); // fluent chaining
    },
});
```

### Command with Parameters

Declare parameters with names, types, aliases, and defaults. The CLI client uses this metadata for autocompletion and validation.

```typescript
import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
} from '@qodalis/cli-server-node';

class TimeProcessor extends CliCommandProcessor {
    command = 'time';
    description = 'Shows the current server time';

    parameters = [
        new CliCommandParameterDescriptor(
            'utc',           // name
            'Show UTC time', // description
            false,           // required
            'boolean',       // type
        ),
        new CliCommandParameterDescriptor(
            'format',                  // name
            'Date/time format string', // description
            false,                     // required
            'string',                  // type
            ['-f'],                    // aliases
            'ISO',                     // defaultValue
        ),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const useUtc = 'utc' in (command.args ?? {});
        const now = new Date();
        return useUtc ? `UTC: ${now.toISOString()}` : `Local: ${now.toLocaleString()}`;
    }
}
```

Parameter types: `'string'`, `'number'`, `'boolean'`.

### Sub-commands

Nest processors to create command hierarchies like `math add --a 5 --b 3`:

```typescript
import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
} from '@qodalis/cli-server-node';

class MathAddProcessor extends CliCommandProcessor {
    command = 'add';
    description = 'Adds two numbers';

    parameters = [
        new CliCommandParameterDescriptor('a', 'First number', true, 'number'),
        new CliCommandParameterDescriptor('b', 'Second number', true, 'number'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const a = Number(command.args?.a);
        const b = Number(command.args?.b);
        return `${a} + ${b} = ${a + b}`;
    }
}

class MathMultiplyProcessor extends CliCommandProcessor {
    command = 'multiply';
    description = 'Multiplies two numbers';

    parameters = [
        new CliCommandParameterDescriptor('a', 'First number', true, 'number'),
        new CliCommandParameterDescriptor('b', 'Second number', true, 'number'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const a = Number(command.args?.a);
        const b = Number(command.args?.b);
        return `${a} * ${b} = ${a * b}`;
    }
}

class MathProcessor extends CliCommandProcessor {
    command = 'math';
    description = 'Performs basic math operations';
    allowUnlistedCommands = false;

    processors = [
        new MathAddProcessor(),
        new MathMultiplyProcessor(),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return 'Usage: math add|multiply --a <number> --b <number>';
    }
}
```

## Modules

Modules group related command processors into a reusable unit. Implement `ICliModule` (or extend the `CliModule` base class) to bundle processors under a single name and version.

### Defining a Module

```typescript
import { CliModule, CliCommandProcessor, CliProcessCommand, ICliCommandProcessor } from '@qodalis/cli-server-node';

class WeatherCurrentProcessor extends CliCommandProcessor {
    command = 'current';
    description = 'Shows current weather conditions';

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return `Weather: Sunny, 22°C`;
    }
}

class WeatherForecastProcessor extends CliCommandProcessor {
    command = 'forecast';
    description = 'Shows a 3-day weather forecast';

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return `Forecast: Sunny for 3 days`;
    }
}

class CliWeatherCommandProcessor extends CliCommandProcessor {
    command = 'weather';
    description = 'Shows weather information for a location';
    processors: ICliCommandProcessor[] = [
        new WeatherCurrentProcessor(),
        new WeatherForecastProcessor(),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return `Weather: Sunny, 22°C`;
    }
}

export class WeatherModule extends CliModule {
    name = 'weather';
    version = '1.0.0';
    description = 'Provides weather information commands';
    processors: ICliCommandProcessor[] = [new CliWeatherCommandProcessor()];
}
```

### Registering a Module

```typescript
const { app, eventSocketManager } = createCliServer({
    configure: (builder) => {
        builder.addModule(new WeatherModule());
    },
});
```

`addModule()` iterates over the module's `processors` and registers each one, just like calling `addProcessor()` for each individually.

### ICliModule Interface

| Member | Type | Description |
|--------|------|-------------|
| `name` | `string` | Unique module identifier |
| `version` | `string` | Module version |
| `description` | `string` | Short description |
| `author` | `ICliCommandAuthor` | Author metadata (defaults to library author) |
| `processors` | `ICliCommandProcessor[]` | Command processors provided by the module |

### Example: Weather Module

The repository includes a weather module under `plugins/weather/` as a reference implementation. It registers a `weather` command with `current` and `forecast` sub-commands, using the [wttr.in](https://wttr.in) API:

```
weather                    # Shows current weather (default: London)
weather current London     # Current conditions for London
weather forecast --location Paris  # 3-day forecast for Paris
```

## Command Input

Every processor receives a `CliProcessCommand` with the parsed command input:

| Property | Type | Description |
|----------|------|-------------|
| `command` | `string` | Command name (e.g., `"time"`) |
| `value` | `string \| undefined` | Positional argument (e.g., `"hello"` in `echo hello`) |
| `args` | `Record<string, any>` | Named parameters (e.g., `--format "HH:mm"`) |
| `chainCommands` | `string[]` | Sub-command chain (e.g., `["add"]` in `math add`) |
| `rawCommand` | `string` | Original unprocessed input |
| `data` | `any` | Arbitrary data payload from the client |

## API Endpoints

The server exposes versioned endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/qcli/versions` | Version discovery (supported versions, preferred version) |
| GET | `/api/v1/qcli/version` | V1 server version |
| GET | `/api/v1/qcli/commands` | V1 commands (all processors) |
| POST | `/api/v1/qcli/execute` | V1 execute |
| POST | `/api/v1/qcli/execute/stream` | V1 SSE streaming execute |
| POST | `/api/qcli/mcp` | MCP endpoint (when the `mcp` option is on, see [MCP Endpoint](#mcp-endpoint)) |
| WS | `/ws/qcli/events` | WebSocket events (also `/ws/v1/qcli/events`) |
| WS | `/ws/v1/qcli/shell` | Interactive PTY shell session |

`GET /capabilities` reports `shell: true|false` and, when the shell is enabled, `shellAuth: 'users' | 'token' | 'custom' | 'anonymous' | 'locked'`.

## MCP Endpoint

The server can expose **the whole system** to AI clients (Claude Code, Claude Desktop, Cursor, …) over the [Model Context Protocol](https://modelcontextprotocol.io): CLI commands, the filesystem API, the data explorer, jobs and tools contributed by plugins, each with the same permissions as a CLI user. It works with or without the users plugin.

### Enabling

MCP is off by default. Enable it with the `mcp` option:

```typescript
const { app, mcp } = createCliServer({
    mcp: true,                         // or an options object:
    // mcp: {
    //     tools: ['weather_*', 'echo'],  // allow-list (trailing * = prefix); default: every tool
    //     exclude: ['fs_delete'],        // deny-list, applied after `tools`
    //     token: process.env.MCP_TOKEN,  // only WITHOUT an auth provider: required bearer token
    //     instructions: 'Each tool runs one command of this server.', // returned by initialize
    //     enabled: true,                 // default true when the object is given
    // },
    configure: (builder) => builder.addProcessor(new CliEchoCommandProcessor()),
});
```

### Route and transport

- `POST /api/qcli/mcp` (`{basePath}/mcp`): MCP *Streamable HTTP*, **stateless** (no `Mcp-Session-Id`) and **JSON responses only** (no SSE). `GET`/`DELETE` → `405` with `Allow: POST`.
- JSON-RPC 2.0: notifications → `202` with an empty body; malformed JSON → `-32700`, invalid request (including batches) → `-32600`, unknown method → `-32601`, bad params → `-32602` (JSON-RPC errors use HTTP 200).
- Methods: `initialize` (protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`; the client's version is echoed when supported, otherwise the newest), `ping`, `tools/list`, `tools/call`.
- An `Origin` header, when present, must be in `allowedOrigins` or same-origin, otherwise `403` (DNS-rebinding protection; checked before authentication).

### Authentication

| Server | Access |
|---|---|
| users plugin mounted (`protectServer`) | a session or an [API token](plugins/users/README.md#api-tokens) (`Authorization: Bearer qcli_pat_…`) holding `commands:execute`; `401`/`403` as plain `{ "error": … }` responses. `tools/list` and `tools/call` only show the tools whose permissions the caller holds. `mcp.token` is ignored. |
| no auth provider, `mcp.token` set | `Authorization: Bearer <token>` (constant-time compare), else `401` |
| no auth provider, no token | open, like `/execute` |

### Tools

Tools are collected from **tool providers** on every request, so new registrations, enabled features and the caller's permissions are always current. The `tools`/`exclude` lists apply to every tool.

| Provider | Tools | Permissions | Annotations |
|---|---|---|---|
| server | `server_info` (version, capabilities, enabled features, command names) | — | read-only |
| commands | one tool per command (below) | `commands:execute` + `requiredPermissions` along the chain | — |
| filesystem (when a file storage provider is configured) | `fs_list {path}`, `fs_stat {path}`, `fs_read {path, maxBytes?=262144}` | `files:read` | read-only |
| | `fs_write {path, content}`, `fs_mkdir {path}` | `files:write` | — |
| | `fs_delete {path, recursive?=false}` | `files:write` | destructive |
| data explorer (when sources are registered) | `data_sources`, `data_schema {source}` | `data:query` | read-only |
| | `data_query {source, query, parameters?}` | `data:query` | — |
| jobs (when the jobs plugin is mounted) | `jobs_list`, `jobs_get {id}`, `jobs_history {id, limit?=20}` | `jobs:read` | read-only |
| | `jobs_trigger`, `jobs_pause`, `jobs_resume`, `jobs_stop`, `jobs_cancel` `{id}` | `jobs:manage` | `jobs_stop`/`jobs_cancel` destructive |

Feature tools use the same services as the HTTP routes (the storage provider and its path checks, the data explorer executor with its timeouts and row limits, the job scheduler); their errors become `isError: true` results. `fs_read` returns UTF-8 text (binary files → `isError` `binary file, N bytes`).

**Command tools**: every root command and sub-command that has no sub-commands, declares parameters or takes a value (`valueRequired`) becomes a tool named after its path joined with `_` (`weather`, `weather_current`), lower-cased, other characters than `[a-z0-9_-]` replaced by `-`, at most 64 characters. The input schema has one property per parameter (`string`, `number`, `boolean`, `array` of strings; anything else is a string) plus `value` (the positional input) when the command takes one. A call builds the same command the CLI would send and runs it through the **same executor as `/execute`**; the outputs are rendered as text (tables as `a | b` rows, lists one item per line, JSON pretty-printed, key-value as `key: value`), `isError` is `exitCode != 0`, and a single JSON-object output is also returned as `structuredContent`. Unknown tools and invalid arguments (wrong type, unknown or missing property) are JSON-RPC `-32602` errors.

Name collisions: built-in feature tools win over command tools, command tools over plugin tools, and between plugins the first registered wins (a warning is logged). The interactive shell is never a tool.

### Adding tools (providers)

```typescript
import { McpToolProvider, mcpObjectSchema } from '@qodalis/cli-server-node';

const provider: McpToolProvider = {
    name: 'inventory',
    getTools: () => [
        {
            name: 'inventory_count',
            description: 'Count the items of a warehouse',
            inputSchema: mcpObjectSchema({ warehouse: { type: 'string' } }, ['warehouse']),
            requiredPermissions: ['inventory:read'], // checked for list and call (with an auth provider)
            annotations: { readOnlyHint: true },
            call: async (args, { auth, signal }) => ({ text: `42 items in ${args.warehouse}`, isError: false }),
        },
    ],
};

const server = createCliServer({ mcp: true });
server.mcp.addProvider(provider);            // or builder.addMcpToolProvider(provider) in `configure`
// plugins can also return `mcpProviders: [provider]` from their build result (picked up by mountPlugin)
```

Arguments are validated against `inputSchema` before `call` runs. Return `structured` to also send `structuredContent`.

### Using the MCP endpoint from an MCP client

With the users plugin, sign in, create an API token (`POST /api/v1/qcli/tokens`, or `token create <name>` in the web CLI) and register the server:

```bash
claude mcp add --transport http qcli http://localhost:8047/api/qcli/mcp --header "Authorization: Bearer <token>"
```

Without the users plugin use the `mcp.token` value as `<token>` (or omit the header on an open server).

## Remote Shell Security

The PTY shell (`/ws/v1/qcli/shell`, `/ws/qcli/shell`) gives OS-level access to the server. It is **off** unless `enableShell: true`. When enabled, exactly one access mode applies:

| Mode (`shellAuth`) | When | Client must |
|---|---|---|
| `users` | the users plugin is mounted | connect with a WS ticket (`?ticket=`) of a session holding `shell:execute` |
| `token` | no users plugin, `shell.token` set | send `Authorization: Bearer <token>` (header, or the `_header_Authorization` query parameter) |
| `custom` | no users plugin, `shell.authorize` set | pass the host's `authorize(request, { url, remoteAddress, mode })` check |
| `anonymous` | no users plugin, `shell.allowAnonymous: true` | nothing (a startup WARNING is logged) |
| `locked` | none of the above | — every connection is closed with 4401 and a startup ERROR explains the options |

Precedence: users plugin mounted (even with `protectServer: false`) ⇒ `users`; otherwise `token`, then `custom`, then `anonymous`. Whatever the mode, **every configured check among `token` and `authorize` must pass** (so with both set, both are required and `shellAuth` reports `token`); `allowAnonymous` is ignored once either is set. Tokens are compared in constant time (SHA-256 of both, then `timingSafeEqual`) and never logged; an `authorize` that throws or rejects denies.

### With the users plugin

```typescript
const { mountPlugin, eventSocketManager } = createCliServer({ enableShell: true });
mountPlugin(new CliUsersBuilder().build((m) => eventSocketManager.broadcastMessage(m)));
// Grant shell:execute to a group (root/admin has '*'):
//   PUT /api/v1/qcli/groups/ops  { "permissions": ["commands:execute", "shell:execute"] }
```

An open shell is bound to the session that opened it: logout, idle/absolute session expiry, admin revoke (kick), user disabled or deleted, or losing `shell:execute` (checked once more right after the shell is registered and before it is spawned, so a logout racing the open is not missed; then immediately on session/user/group changes and every `sessionCheckIntervalMs`, default 30 s, max 60 s), or a password change becoming required closes it with **4401** `session ended` and kills its process tree. Users authenticated by an external auth adapter have no stored session: their shells are re-checked by calling the adapter again with the shell's original upgrade request (see the users plugin README). Re-checks never extend the session by themselves; stdin received since the previous check counts as session activity (at most one touch per 30 s), so an active shell user is not idle-logged-out. Opens and closes are audited as `shell_opened` / `shell_closed` (`userId`, `actorId`, `metadata: { mode: 'interactive' | 'command', sessionId, durationMs, reason, exitCode? }`), never with the command text or stdin. `reason` is one of `exited` (then `exitCode` is set), `closed`, `session ended`, `permission removed`, `shell timed out`, `server shutdown`, `error`.

### Without the users plugin (token mode)

```typescript
createCliServer({
    enableShell: true,
    shell: { token: process.env.QCLI_SHELL_TOKEN },   // long random secret
});
```

Browser clients cannot set WebSocket headers: configure the server in web-cli with `headers: { Authorization: 'Bearer <token>' }` and the client forwards it as `?_header_Authorization=Bearer%20<token>`. The standalone server (`src/server.ts`) enables token mode when `QCLI_SHELL_TOKEN` is set. Use HTTPS/WSS so the token is not sent in clear text.

For your own scheme (reverse-proxy identity, IP allow-list, …) use `authorize`:

```typescript
createCliServer({
    enableShell: true,
    shell: { authorize: async (req, { remoteAddress }) => remoteAddress === '127.0.0.1' && req.headers['x-ops'] === 'yes' },
});
```

Non-users modes log one info line per open/close (remote address, mode, reason) without the command text.

### Options

```typescript
shell: {
    token?: string;                    // token mode (or extra requirement with the users plugin)
    authorize?: (req, ctx) => boolean | Promise<boolean>;  // custom mode (or extra requirement)
    allowAnonymous?: boolean;          // open to anyone who can reach the server (not recommended)
    maxSessionsPerUser?: number;       // per user (users mode) or per remote address (default 3; X-Forwarded-For only with trustProxy)
    maxSessions?: number;              // total concurrent shells (default 20)
    idleTimeoutMs?: number;            // close after no stdin (resize does not count; default 15 min, 0 = off)
    maxDurationMs?: number;            // absolute limit (default none)
    sessionCheckIntervalMs?: number;   // users-mode re-check (default 30 000, max 60 000)
    cwd?: string;                      // working directory (default: home directory)
    shell?: string;                    // shell binary (default: detected)
    env?: { allow?: string[]; set?: Record<string, string> };
}
```

The shell does **not** inherit the server environment: it gets only `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `COLUMNS`, `LINES`, `SHELL` (plus the variables Windows needs to start PowerShell), the names in `env.allow`, and `env.set`. Secrets such as database passwords stay out of the shell.

### Process cleanup

Whenever a shell ends (exit, client close, session ended or permission removed, timeout, server shutdown), the server first collects everything the shell started — its process group, its descendants by parent PID (including background jobs that interactive shells move to their own process groups, and `setsid`/`nohup` children), on Linux every process of its session, and every process tagged with the shell's marker (below) — and then sends SIGHUP, SIGTERM and, after a 1 s grace period, SIGKILL to all of them (re-collecting before the SIGKILL). The server's own process and process group are never targeted. Linux reads `/proc` for everything (no `ps` needed); macOS and other Unixes run `ps`. On Windows only the shell process is killed.

Every shell gets a unique marker in its environment, `QCLI_SHELL_ID=<random 128-bit hex>`, added after the `env.allow`/`env.set` filtering so configuration can neither override nor remove it. Children inherit it, so processes that were re-parented to init *and* left the shell's process group and session — e.g. `setsid sleep 100 &` from an interactive shell, double-forking daemons — are still found: on Linux by reading `/proc/<pid>/environ`, on macOS through `ps -A -E -ww` (which shows the environment of the server user's processes).

Limitations: a process escapes only if it deliberately unsets or changes `QCLI_SHELL_ID` before detaching (`env -u QCLI_SHELL_ID setsid …`), or runs as a different user whose environment the server cannot read (e.g. via `sudo`). On macOS the environment of Apple platform binaries (`/bin/sleep`, `/usr/bin/perl`, …) is hidden from `ps -E`, so such a binary that left the shell's tree and session is not found there either. Run the server in a container or under a service manager (cgroup) if every process must be contained.

### Close codes

Refusals are sent as *accept, then close* so browsers can read them (a foreign `Origin` is still rejected with HTTP 403):

| Code | Reason | When |
|---|---|---|
| 4401 | `login required` / `session ended` / `shell access is not configured` | missing ticket or (Bearer) token; session ended (logout, expiry, kick, user disabled/deleted, `shell:execute` removed, password change now required) — shell, events and logs sockets; shell locked |
| 4403 | `forbidden` | wrong token, `authorize` false or threw, no `shell:execute`, password change required |
| 4404 | `shell disabled` | `enableShell` is false |
| 4408 | `shell timed out` | idle timeout or `maxDurationMs` |
| 4429 | `too many shell sessions` | `maxSessionsPerUser` or `maxSessions` reached |
| 1001 | `server shutdown` | the server is shutting down |

## Processor Base Class Reference

`CliCommandProcessor` provides these members:

| Member | Type | Default | Description |
|--------|------|---------|-------------|
| `command` | `string` | (required) | Command name |
| `description` | `string` | (required) | Help text shown to users |
| `handleAsync` | method | (required) | Execution logic |
| `parameters` | `ICliCommandParameterDescriptor[]` | `undefined` | Declared parameters |
| `processors` | `ICliCommandProcessor[]` | `undefined` | Sub-commands |
| `allowUnlistedCommands` | `boolean` | `undefined` | Accept sub-commands not in `processors` |
| `valueRequired` | `boolean` | `undefined` | Require a positional value |
| `version` | `string` | `'1.0.0'` | Processor version string |
| `author` | `ICliCommandAuthor` | default author | Author metadata (name, email) |

## Server Options

```typescript
interface CliServerOptions {
    basePath?: string;                     // API base path (default: '/api/qcli')
    cors?: boolean | cors.CorsOptions;     // CORS config (default: only allowedOrigins; off when none)
    allowedOrigins?: string[];             // CORS + WebSocket Origin allow-list ('http://host:*' = any port)
    enableShell?: boolean;                 // Interactive shell WebSocket (default: false)
    shell?: CliShellOptions;               // Shell access mode, limits, timeouts, env (see Remote Shell Security)
    trustProxy?: boolean | number;         // Trusted proxy hops for X-Forwarded-* (true = 1; default false = none)
    auth?: ICliServerAuth;                 // Protect the whole server (e.g. usersPlugin.serverAuth)
    mcp?: boolean | CliMcpOptions;         // MCP endpoint at {basePath}/mcp (default off, see MCP Endpoint)
    configure?: (builder: CliBuilder) => void;  // Processor registration
}
```

CORS is disabled unless `allowedOrigins` (or an explicit `cors` option) is given. The shell socket is off unless `enableShell: true`, and even then it is locked until an access mode applies (see [Remote Shell Security](#remote-shell-security)).

Same-origin requests (e.g. the bundled admin dashboard at `/qcli/admin`) are always allowed by the Origin, CORS and CSRF checks, even when `allowedOrigins` does not list the server's own origin (`X-Forwarded-Proto`/`X-Forwarded-Host` are honoured only with `trustProxy`, and read like `X-Forwarded-For`: the entry at index `len - hops`, the leftmost when the list is shorter, an empty entry ignored).

`trustProxy` is the number of trusted reverse-proxy hops in front of the server (`true` = 1, `false`/`0`/absent = none). With n hops the client IP (Express `req.ip`, the shell's per-address limits) is the `X-Forwarded-For` entry at index `len - n` of the comma-separated list, i.e. with one hop the rightmost entry, appended by your proxy; the leftmost entries are client-controlled and never used unless the list is shorter than n. Without the header (or when the selected entry is empty) the socket address is used. Set it to the exact number of proxies you run, otherwise clients can spoof their IP.

When the users plugin is mounted (`mountPlugin(usersPlugin)`) or passed as `auth`, every `/api/...` route and every WebSocket requires a users session (see [Users Plugin](#users-plugin)); without it the server behaves as before.

`createCliServer()` returns:

```typescript
{
    app: Express;                          // Configured Express app
    registry: CliCommandRegistry;          // Processor registry
    builder: CliBuilder;                   // Registration builder
    executor: CliCommandExecutorService;   // Command executor
    eventSocketManager: CliEventSocketManager;  // WebSocket event manager
    logSocketManager: CliLogSocketManager;      // WebSocket log manager
    mountPlugin(plugin: MountablePlugin): void; // Mount a plugin with its routes (installs plugin.serverAuth)
    setAuth(auth?: ICliServerAuth): void;       // Install/remove the server auth provider
    mcp: CliServerMcp;                          // MCP endpoint: { enabled, path, addProvider(provider) }
}
```

## Exported Types

All types are exported from the package root for TypeScript consumers:

```typescript
// Abstractions (for creating custom processors and modules)
import {
    ICliCommandProcessor,
    CliCommandProcessor,
    ICliCommandParameterDescriptor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandAuthor,
    CliCommandAuthor,
    ICliModule,
    CliModule,
} from '@qodalis/cli-server-node';

// Models
import {
    CliServerResponse,
    CliServerOutput,
    CliServerCommandDescriptor,
} from '@qodalis/cli-server-node';

// Services (for advanced integration)
import {
    ICliCommandRegistry,
    CliCommandRegistry,
    ICliCommandExecutorService,
    CliCommandExecutorService,
    ICliResponseBuilder,
    CliResponseBuilder,
    CliEventSocketManager,
} from '@qodalis/cli-server-node';

// Factory
import {
    createCliServer,
    CliServerOptions,
} from '@qodalis/cli-server-node';
```

## File Storage

The server includes a pluggable file storage system exposed at `/api/qcli/fs/*`. Enable it with `setFileStorageProvider()` and choose a storage backend.

### Filesystem API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/qcli/fs/ls?path=/` | List directory contents |
| GET | `/api/qcli/fs/cat?path=/file.txt` | Read file content |
| GET | `/api/qcli/fs/stat?path=/file.txt` | File/directory metadata |
| GET | `/api/qcli/fs/download?path=/file.txt` | Download file |
| POST | `/api/qcli/fs/upload` | Upload file (multipart) |
| POST | `/api/qcli/fs/mkdir` | Create directory |
| DELETE | `/api/qcli/fs/rm?path=/file.txt` | Delete file or directory |

### Storage Providers

```typescript
import { InMemoryFileStorageProvider, OsFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { JsonFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-json';
import { SqliteFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-sqlite';
import { S3FileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-s3';

const { app, eventSocketManager } = createCliServer({
    configure: (builder) => {
        // In-memory (default) — files lost on restart
        builder.setFileStorageProvider(new InMemoryFileStorageProvider());

        // OS filesystem
        builder.setFileStorageProvider(new OsFileStorageProvider());

        // JSON file — persists to a single JSON file
        builder.setFileStorageProvider(
            new JsonFileStorageProvider({ filePath: './data/files.json' }),
        );

        // SQLite — persists to a SQLite database
        builder.setFileStorageProvider(
            new SqliteFileStorageProvider({ dbPath: './data/files.db' }),
        );

        // Amazon S3
        builder.setFileStorageProvider(
            new S3FileStorageProvider({
                bucket: 'my-cli-files',
                region: 'us-east-1',
                prefix: 'uploads/',
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
                },
            }),
        );
    },
});
```

### Custom Provider

Implement `IFileStorageProvider` to add your own backend:

```typescript
import { IFileStorageProvider, FileEntry, FileStat } from '@qodalis/cli-server-node';

class MyProvider implements IFileStorageProvider {
    readonly name = 'my-provider';
    async list(path: string): Promise<FileEntry[]> { /* ... */ }
    async readFile(path: string): Promise<string> { /* ... */ }
    async writeFile(path: string, content: string | Buffer): Promise<void> { /* ... */ }
    async stat(path: string): Promise<FileStat> { /* ... */ }
    async mkdir(path: string, recursive?: boolean): Promise<void> { /* ... */ }
    async remove(path: string, recursive?: boolean): Promise<void> { /* ... */ }
    async copy(src: string, dest: string): Promise<void> { /* ... */ }
    async move(src: string, dest: string): Promise<void> { /* ... */ }
    async exists(path: string): Promise<boolean> { /* ... */ }
    async getDownloadStream(path: string): Promise<Readable> { /* ... */ }
    async uploadFile(path: string, content: Buffer): Promise<void> { /* ... */ }
}

builder.setFileStorageProvider(new MyProvider());
```

## Data Explorer

The Data Explorer plugin provides interactive, full-screen REPL access to data sources. It exposes a provider-based API where each data source type (SQL, MongoDB, etc.) is a separate plugin implementing `IDataExplorerProvider`.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/qcli/data-explorer/sources` | List registered data sources with metadata |
| POST | `/api/qcli/data-explorer/execute` | Execute a query against a named source |

### SQL Provider

```typescript
import { SqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-sql';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const { app } = createCliServer({
    configure: (builder) => {
        builder.addDataExplorerProvider(
            new SqlDataExplorerProvider({ type: 'sqlite', filename: './data.db' }),
            {
                name: 'my-database',
                description: 'Application database',
                language: DataExplorerLanguage.Sql,
                defaultOutputFormat: DataExplorerOutputFormat.Table,
                timeout: 30000,
                maxRows: 1000,
                templates: [
                    {
                        name: 'list_tables',
                        query: "SELECT name FROM sqlite_master WHERE type='table'",
                        description: 'List all tables',
                    },
                ],
            },
        );
    },
});
```

### MongoDB Provider

```typescript
import { MongoDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-mongo';

builder.addDataExplorerProvider(
    new MongoDataExplorerProvider({
        connectionString: 'mongodb://localhost:27017',
        database: 'myapp',
    }),
    {
        name: 'mongo-primary',
        description: 'Primary MongoDB database',
        language: DataExplorerLanguage.Json,
        defaultOutputFormat: DataExplorerOutputFormat.Json,
        templates: [
            { name: 'show_collections', query: 'show collections', description: 'List all collections' },
            { name: 'find_users', query: 'db.users.find({})', description: 'Find all users' },
        ],
    },
);
```

**Supported MongoDB operations:** `db.collection.find({...})`, `findOne`, `aggregate([...])`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `countDocuments`, `distinct`. Convenience commands: `show collections`, `show dbs`.

### Custom Provider

Implement `IDataExplorerProvider` to add your own data source:

```typescript
import { IDataExplorerProvider, DataExplorerExecutionContext, DataExplorerResult } from '@qodalis/cli-server-abstractions';

class MyProvider implements IDataExplorerProvider {
    async executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult> {
        // context.query — the user's query string
        // context.parameters — key-value parameters
        // context.options — provider options (name, language, etc.)
        return {
            success: true,
            source: context.options.name,
            language: context.options.language,
            defaultOutputFormat: context.options.defaultOutputFormat,
            executionTime: 0,
            columns: ['id', 'name'],       // null for document-oriented results
            rows: [[1, 'Alice'], [2, 'Bob']], // objects when columns is null
            rowCount: 2,
            truncated: false,
            error: null,
        };
    }
}

builder.addDataExplorerProvider(new MyProvider(), { name: 'custom', ... });
```

The same provider class can be registered multiple times with different configurations (e.g., two databases with different names).

## AWS Cloud Services

The AWS plugin adds commands for managing AWS resources (S3, EC2, Lambda, CloudWatch, SNS, SQS, IAM, DynamoDB, ECS) directly from the CLI. It uses AWS SDK v3 and supports the full credential chain.

```typescript
import { AwsModule } from '@qodalis/cli-server-plugin-aws';

const { app } = createCliServer({
    configure: (builder) => {
        builder.addModule(new AwsModule());
    },
});
```

### Authentication

The plugin resolves credentials in this order:

1. **CLI configure**: `aws configure set --key <KEY> --secret <SECRET> --region <REGION>`
2. **Environment variables**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
3. **AWS profiles**: `aws configure set --profile <name>`
4. **IAM roles**: Automatic on EC2/ECS/Lambda

Verify connectivity with `aws status`.

### Available Commands

| Service | Commands |
|---------|----------|
| **configure** | `aws configure set`, `aws configure get`, `aws configure profiles` |
| **status** | `aws status` — STS GetCallerIdentity connectivity check |
| **S3** | `aws s3 ls`, `aws s3 cp`, `aws s3 rm`, `aws s3 mb`, `aws s3 rb`, `aws s3 presign` |
| **EC2** | `aws ec2 list`, `aws ec2 describe`, `aws ec2 start`, `aws ec2 stop`, `aws ec2 reboot`, `aws ec2 sg list` |
| **Lambda** | `aws lambda list`, `aws lambda invoke`, `aws lambda logs` |
| **CloudWatch** | `aws cloudwatch alarms`, `aws cloudwatch logs`, `aws cloudwatch metrics` |
| **SNS** | `aws sns topics`, `aws sns publish`, `aws sns subscriptions` |
| **SQS** | `aws sqs list`, `aws sqs send`, `aws sqs receive`, `aws sqs purge` |
| **IAM** | `aws iam users`, `aws iam roles`, `aws iam policies` |
| **DynamoDB** | `aws dynamodb tables`, `aws dynamodb describe`, `aws dynamodb scan`, `aws dynamodb query` |
| **ECS** | `aws ecs clusters`, `aws ecs services`, `aws ecs tasks` |

All commands support `--region` (`-r`) for region override and `--output` (`-o`) for format selection (`table`, `json`, `text`). Destructive commands support `--dry-run`.

See [`plugins/aws/README.md`](plugins/aws/README.md) for the full command reference.

### Users Plugin

The users plugin (`@qodalis/cli-server-plugin-users`) adds REST endpoints under `/api/v1/qcli` for authentication, users, groups with permissions, sessions and an audit log, with swappable storage (in-memory by default). It is the server side of the `@qodalis/cli-users` browser plugin's *server mode*.

```typescript
import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';

const usersPlugin = new CliUsersBuilder()
    .build((msg) => eventSocketManager.broadcastMessage(msg));
mountPlugin(usersPlugin); // protects the whole server (protectServer: true)
```

Once mounted, every server route and socket requires a users session (login, version discovery and capabilities stay public):

| Surface | Permission |
|---|---|
| `GET /commands` | authenticated |
| `POST /execute`, `/execute/stream` | `commands:execute` + the processor's `requiredPermissions` |
| `POST /api/qcli/mcp` | `commands:execute` (each tool then checks its own permissions) |
| fs `ls`/`cat`/`stat`/`download` | `files:read` |
| fs `upload`/`mkdir`/`rm` | `files:write` |
| data explorer | `data:query` |
| jobs read / manage | `jobs:read` / `jobs:manage` |
| events / logs / shell WebSocket | authenticated / `logs:read` / `shell:execute` (see [Remote Shell Security](#remote-shell-security)) |
| admin dashboard | `admin:access` |

WebSockets authenticate with a single-use ticket: `POST /api/v1/qcli/sessions/ws-ticket` → `{ ticket, expiresIn: 30 }`, then connect with `?ticket=<ticket>`. Host routes can use `usersPlugin.requireAuth()` / `usersPlugin.requirePermission('perm')`. Processors declare `requiredPermissions: ['deploy:run']` to be enforced server-side.

Events and logs sockets authenticated with a stored session are bound to it: when the session ends (logout, revoke/kick, user disabled or deleted, a password change becoming required, idle/absolute expiry) the socket is closed with **4401** `session ended`; for a revoke the events socket first receives `session-kicked`. Bound sockets are re-checked on every session/user/group change and after each expired-session sweep (`setCleanupInterval`, default 5 minutes). Sockets authenticated by an external auth adapter have no stored session and are not re-checked.

API tokens (`qcli_pat_…`) are long-lived, revocable bearer tokens for MCP clients, CI and scripts; they are accepted wherever a session token is (see [API tokens](plugins/users/README.md#api-tokens)). Sockets opened with a token identity close with 4401 when the token is revoked or expires, or the user is disabled.

See [`plugins/users/README.md`](plugins/users/README.md) for options, endpoints, API tokens, custom storage and external auth adapters.

## Built-in Processors

These processors ship with the library and are included in the standalone server:

| Command | Description |
|---------|-------------|
| `echo` | Echoes input text |
| `status` | Server status (uptime, OS info) |
| `system` | Detailed system information (memory, CPU, uptime) |
| `http` | HTTP request operations |
| `hash` | Hash computation (MD5, SHA1, SHA256, SHA512) |
| `base64` | Base64 encode/decode (sub-commands) |

## Docker

```bash
docker run -p 8047:8047 ghcr.io/qodalis-solutions/cli-server-node
```

## Demo

```bash
cd demo
npm install
npm start
# Server starts on http://localhost:8047
```

## Testing

```bash
npm test          # Run test suite (Vitest)
npm run test:watch  # Watch mode
```

## Project Structure

```
packages/
  abstractions/                       # @qodalis/cli-server-abstractions (zero-dep)
    src/
      cli-command-processor.ts        # ICliCommandProcessor interface & base class
      cli-module.ts                   # ICliModule interface & base class
      cli-process-command.ts          # Command input model
      cli-command-parameter-descriptor.ts  # Parameter declaration
      cli-command-author.ts           # Author metadata
plugins/
  admin/                              # Admin dashboard plugin (auth, status, config, logs)
  aws/                                # AWS cloud services (S3, EC2, Lambda, CloudWatch, etc.)
  data-explorer/                      # Core data explorer abstraction
  data-explorer-sql/                  # SQL data explorer provider (SQLite)
  data-explorer-mongo/                # MongoDB data explorer provider
  data-explorer-postgres/             # PostgreSQL data explorer provider
  data-explorer-mysql/                # MySQL data explorer provider
  data-explorer-mssql/                # MS SQL data explorer provider
  data-explorer-redis/                # Redis data explorer provider
  data-explorer-elasticsearch/        # Elasticsearch data explorer provider
  filesystem/                         # Core file storage abstraction (IFileStorageProvider, InMemory, OS)
  filesystem-json/                    # JSON file persistence provider
  filesystem-sqlite/                  # SQLite persistence provider (better-sqlite3)
  filesystem-s3/                      # Amazon S3 storage provider (@aws-sdk/client-s3)
  jobs/                               # Job scheduling plugin
  users/                              # Users plugin (auth, sessions, groups, audit)
  weather/                            # Weather module (example plugin)
src/
  abstractions/                       # Re-exports from @qodalis/cli-server-abstractions
  models/
    cli-server-response.ts            # Response wrapper (exitCode + outputs)
    cli-server-output.ts              # Output types (text, table, list, json, key-value)
    cli-server-command-descriptor.ts  # Command metadata for /commands endpoint
  services/
    cli-command-registry.ts           # Processor registry and lookup
    cli-command-executor-service.ts   # Command execution pipeline
    cli-response-builder.ts           # Structured output builder
    cli-event-socket-manager.ts       # WebSocket event broadcasting
    cli-log-socket-manager.ts         # WebSocket log streaming
    cli-shell-session-manager.ts      # PTY shell session management
  controllers/
    cli-controller.ts                 # V1 REST API (/api/v1/qcli)
    cli-version-controller.ts         # Version discovery (/api/qcli/versions)
  extensions/
    cli-builder.ts                    # Fluent registration API (addProcessor, addModule)
  processors/                         # Built-in processors
  create-cli-server.ts               # Factory function
  server.ts                          # Standalone CLI entry point
  index.ts                           # Package exports
demo/                                # Demo app with sample processors
```

## License

MIT
