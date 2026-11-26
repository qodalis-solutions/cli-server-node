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

Run the standalone server instead (the built-in `http` command plus the weather module):

```bash
npx -p @qodalis/cli-server-node qodalis-cli-server
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8047` | Listening port |
| `QCLI_ALLOWED_ORIGINS` | none | Comma-separated origins allowed for CORS and WebSockets |
| `QCLI_SHELL_TOKEN` | none | Enables the remote shell in token mode |
| `QCLI_DATA_DIR` | `./qcli-data` | The server's data directory when `createCliServer` gets no `dataDir`: runtime-installed server plugins, dashboard plugins, plugin data and settings. Must be writable |

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
- Config providers: the server's, its plugins' and the host's settings, viewed and changed from the dashboard, the `config` command and MCP, validated, audited and kept in memory, a JSON file or a database
- Origin checks, CORS allow-list and trusted-proxy handling

## Writing commands

### Processors and parameters

```typescript
import { CliCommandProcessor, CliCommandParameterDescriptor, CliProcessCommand } from '@qodalis/cli-server-node';

class TimeProcessor extends CliCommandProcessor {
    command = 'time';
    description = 'Shows the current server time';
    // Help in the web CLI: everything below is optional
    aliases = ['now'];
    module = 'clock';
    icon = '🕒';
    documentation = 'Prints the server clock, in local time or UTC.\n\nUse --format to pick the layout.';
    examples = [
        { command: 'time', description: 'Local time' },
        { command: 'time --utc --format iso', description: 'UTC as ISO 8601' },
    ];
    parameters = [
        //                               name     description       required type       aliases  default  allowed values
        new CliCommandParameterDescriptor('utc', 'Show UTC time', false, 'boolean'),
        new CliCommandParameterDescriptor('format', 'Output format', false, 'string', ['-f'], 'iso', ['iso', 'locale']),
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
| `parameters` | none | `CliCommandParameterDescriptor[]` (`string`, `number`, `boolean`, ...); `allowedValues` lists the only values a parameter takes (help, Tab completion and a check in the web CLI, `enum` in MCP); `examples` lists example values (help, `examples` in MCP) |
| `aliases` | none | Other names; the server resolves them (and their permissions) like the command |
| `examples` | none | `{ command, description? }[]` shown by `help <command>` in the web CLI |
| `documentation` | none | Longer help text for `help <command>` (paragraphs separated by a blank line) |
| `module`, `icon` | `server:<name>`, 🖥 | The group and emoji the web CLI's `help` lists the command under |
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

### Paging

Commands that can return many rows page them: declare `CliPaging.parameters()` (`--skip`, default 0, and `--take`, default 50, at most 500), read the request with `CliPaging.from(command)` and write the rows with `writePagedTable`. The web CLI shows which rows these are under the table with the command for the next ones.

```typescript
import { CliCommandProcessor, CliPaging, CliProcessCommand, CliResponseBuilder, CliServerResponse } from '@qodalis/cli-server-node';

class OrdersProcessor extends CliCommandProcessor {
    command = 'orders';
    description = 'Lists orders';
    parameters = [...CliPaging.parameters()];

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliServerResponse> {
        const page = CliPaging.from(command);
        const { rows, total } = await db.orders.find({ skip: page.skip, take: page.take });
        const builder = new CliResponseBuilder();
        builder.writePagedTable(['Id', 'Customer'], rows.map((o) => [o.id, o.customer]), page, { total });
        return builder.build();
    }
}
```

The table output carries the page: `{ "type": "table", "headers": [...], "rows": [...], "page": { "skip": 50, "take": 50, "total": 120, "hasMore": true } }`. Without a `total`, pass `hasMore` (query one row more than `take` to find out). Tables from commands that do not page are cut at the `maxTableRows` option (default 200) and marked `"truncated": true`, in `/execute`, `/execute/stream` and MCP results; paged tables are never cut.

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
| `mcp` | off | `true` or `{ tools, exclude, token, instructions, readOnly, enabled }` (see [MCP](#mcp-endpoint)) |
| `config` | in memory | `{ store, environment, command }`: the store of writable settings, the environment variables the `host` provider lists (an allowlist: `QCLI_*`, NODE_ENV, PORT, HOST, TZ, LANG; `allow` adds names), the `config` command (default on); see [Config providers](#config-providers) |
| `cliRoutes` | `true` | `false` serves none of the CLI's routes and sockets (`/api/qcli/*`, `/api/v1/qcli/*`, `/api/cli/*`, `basePath`, MCP, `/ws/*`): for a service that only hosts its own routes (see the users plugin's [guard-only mode](plugins/users/README.md#guard-only-mode)). `mountPlugin` then mounts only plugins with `cliRoutes: false` and logs `[qcli] CLI routes are turned off; <prefix> is not mounted` for the others (the admin dashboard is not served either); a guard-only users plugin is accepted only there (`guard-only needs cliRoutes: false`); the catalog, events and installed plugins stay |
| `maxTableRows` | `200` | Most rows an unpaged table returns; larger tables are cut and marked `truncated` (0 = no limit, see [Paging](#paging)) |
| `configure` | none | `(builder) => ...` to register processors, modules, storage and data sources |

`configure` receives a `CliBuilder`: `addProcessor`, `addModule`, `setFileStorageProvider`, `addFileSystem`, `addDataExplorerProvider`, `addMcpToolProvider`, `addPermissions`, `addConfigProvider`, `setConfigStore`, `setConfigAuditStore` (all chainable; see [Permission catalog and host tokens](#permission-catalog-and-host-tokens)). `builder.permissions` is the server's permission catalog.

`createCliServer` returns:

| Field | Description |
|---|---|
| `app` | The Express app |
| `registry`, `builder`, `executor` | Processor registry, registration builder, command executor |
| `eventSocketManager` | `attach(server)` for the WebSockets, `broadcastMessage`, `broadcastDisconnect` |
| `eventBus` | The server's event bus: `publish(type, data, audience)`, `subscribe(pattern, handler)` (see [Server events](#server-events)) |
| `logSocketManager` | Server log stream socket |
| `mountPlugin(plugin)` | Mounts a plugin's routes (its `publicRoutes` stay public on a protected server: `"METHOD /path"`, or for a plugin with `cliRoutes: false` also `"GET /prefix/*"` for every GET/HEAD under a prefix. A host-route plugin may declare only paths under its own prefix, never a bare `/*` or a non-GET prefix (`invalid public route: <entry>` at mount); its public requests are answered by that plugin alone, never by a host or CLI route; on a protected server they are answered inside the auth gate, before middleware added to the app after `createCliServer`) (and dashboard, MCP providers, server auth); its `prefix` and `dashboardPrefix` then count as CLI routes, where host tokens are refused, unless the plugin serves host routes (`cliRoutes: false`: public-api, docs, portal) |
| `setAuth(auth)` | Installs or removes the server auth provider |
| `mcp` | `{ enabled, path, addProvider(provider) }` |
| `config` | The configuration service (`builder.config`): `list`, `get`, `update` and `ready()` (see [Config providers](#config-providers)) |

Same-origin requests (such as the admin dashboard at `/qcli/admin`) always pass the Origin, CORS and CSRF checks. With `trustProxy` set to n hops, the client IP is the `X-Forwarded-For` entry at index `len - n`; set it to the exact number of proxies you run, otherwise clients can spoof their address.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/qcli/versions` | Supported API versions and the preferred one |
| GET | `/api/v1/qcli/version` | Server version |
| GET | `/api/v1/qcli/capabilities` | OS, shell availability (`shell`, `shellAuth`), streaming, version |
| GET | `/api/v1/qcli/commands` | Registered processors |
| GET | `/api/v1/qcli/commands/stats` | Command usage since start: executions, failures, average duration, last run and failure per root command (`known: false` for unknown commands), most used first |
| POST | `/api/v1/qcli/execute` | Execute a command |
| POST | `/api/v1/qcli/execute/stream` | Execute with Server-Sent Events output |
| GET | `/api/qcli/fs/ls`, `cat`, `stat`, `download` | File storage (when a provider is configured) |
| POST | `/api/qcli/fs/upload`, `mkdir` | Upload (multipart) / create directory |
| DELETE | `/api/qcli/fs/rm` | Delete file or directory |
| GET | `/api/qcli/data-explorer/sources`, `schema` | Data sources and their schema (when sources are registered) |
| POST | `/api/qcli/data-explorer/execute` | Run a query against a source |
| POST | `/api/qcli/mcp` | MCP endpoint (when `mcp` is enabled) |
| GET, PATCH | `/api/v1/qcli/config[/{provider}[/{section}]]` | Config providers (admin plugin, see [Config providers](#config-providers)) |
| WS | `/ws/v1/qcli/events` | Server-push events ([Server events](#server-events)) |
| WS | `/ws/v1/qcli/logs` | Server log stream |
| WS | `/ws/v1/qcli/shell` | Interactive PTY shell (when `enableShell` is on) |

Every WebSocket is also served without the version (`/ws/qcli/events`, ...). Plugins add their own routes: users (`/api/v1/qcli/sessions`, `/users`, `/groups`, `/tokens`, `/permissions`, ...), audit (`/api/v1/qcli/audit`), jobs and admin; see their READMEs.

## Plugins

| Package | Description |
|---|---|
| [`@qodalis/cli-server-plugin-users`](plugins/users/README.md) | Users, groups, permissions, sessions, API tokens; protects the whole server and adds the audit plugin |
| [`@qodalis/cli-server-plugin-users-postgres`](plugins/users-postgres/README.md) | PostgreSQL stores for the users plugin (users, groups, passwords, sessions, API tokens, audit), with versioned migrations |
| [`@qodalis/cli-server-plugin-config-redis`](plugins/config-redis/README.md) | `CliRedisConfigStore`: a [config provider](#config-providers)'s settings in Redis, one hash per section, versioned writes checked atomically |
| [`@qodalis/cli-server-plugin-databases`](plugins/databases/README.md) | The server's relational databases (PostgreSQL, MySQL, SQL Server, SQLite): size, load and largest tables, and versioned migrations applied under a lock, run and tracked from the dashboard, the terminal (`databases`), MCP and the API |
| [`@qodalis/cli-server-plugin-audit`](plugins/audit/README.md) | The audit log: its entries, in-memory store and `GET/DELETE /api/v1/qcli/audit` |
| [`@qodalis/cli-server-plugin-admin`](plugins/admin/README.md) | Admin dashboard at `/qcli/admin` (status, configuration through the [config providers](#config-providers), logs) and the `admin` command |
| [`@qodalis/cli-server-plugin-public-api`](plugins/public-api/README.md) | Your public REST API: a host-token guard with per-account daily and per-minute quotas, usage per token, your OpenAPI document and Swagger UI at `/qcli/api` |
| [`@qodalis/cli-server-plugin-docs`](plugins/docs/README.md) | Markdown guides from folders or code (front matter, variables), served as JSON at `/qcli/docs` and read with `docs` |
| [`@qodalis/cli-server-plugin-portal`](plugins/portal/README.md) | The documentation portal (guides and API reference with code samples) at `/qcli/portal` |
| [`@qodalis/cli-server-plugin-jobs`](plugins/jobs/README.md) | Cron and interval background jobs with history and REST management; `maxConcurrentRuns` per job and an overlap policy, never a job started twice |
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

const { app, mountPlugin } = createCliServer({ /* ... */ });

// mountPlugin hands each plugin the server's event bus
mountPlugin(new CliJobsBuilder().addJob(new HealthCheckJob(), { name: 'health', interval: '30s' }).build());
mountPlugin(new CliUsersBuilder().setDefaultAdminPassword(process.env.ADMIN_PASSWORD!).build());
```

`build()` also takes the bus (`build(eventBus)`) or, as before, a function broadcasting raw messages
(`build((msg) => eventSocketManager.broadcastMessage(msg))`). A plugin given a function keeps it; one given nothing
receives the server's bus when mounted.

## Server plugins installed at runtime

A server plugin can be installed while the server runs, from the admin dashboard's Marketplace tab or `admin plugins
install <name>` ([admin plugin](plugins/admin/README.md#server-plugins-from-the-marketplace)): the server unpacks
its verified package into `<dataDir>/server-plugins` with only the dependencies the marketplace pins (each checked
against its sha512) or the host trusts (`trustedDependencies`), sharing every package it already has, and loads it at
the next start. No host code changes, no install scripts.

```ts
const server = createCliServer({
    dataDir: './qcli-data',      // default: QCLI_DATA_DIR, else ./qcli-data, from the working directory
    serverPlugins: {},           // default; { dir } keeps them elsewhere, false loads none
});
// ... the host's own mountPlugin calls ...
await server.serverPlugins.ready(); // the runtime plugins are loaded after the host's mounts; await before listening
```

The data directory holds everything the server writes at runtime: `server-plugins/`, the admin plugin's
`dashboard-plugins/`, `plugin-data/<id>/` and `plugin-settings.json`, so it must be writable. In a container that runs
as a non-root user, point it at a volume (`dataDir`, or the `QCLI_DATA_DIR` environment variable when the host sets
none). When the admin marketplace is on and a plugins folder cannot be created or written, the server logs one startup
WARNING naming it, and installing, updating or removing a plugin answers 500 with `{ "error": "cannot write the plugins
folder <folder>: permission denied (EACCES). Set dataDir (or QCLI_DATA_DIR) to a writable folder" }` (the `admin
dashboard|plugins install` commands print the same).

At startup the server reads `<dataDir>/server-plugins/installed.json` and, for each plugin, requires its package's
entry from `<dataDir>/server-plugins/node_modules` and calls `createPlugin(context)`. A plugin that fails (missing
package, wrong version, no entry, an exception) is logged and its error kept in `installed.json` (`error`, cleared once
it loads); startup goes on. A plugin whose required settings have no value is `needs-configuration` (below). A package
the host already installed in code is skipped. Loaded packages are listed by
`GET /api/v1/qcli/plugins/installed` with `source: "marketplace"`; their routes are reachable even after a catch-all
the host added; a filesystem storage or data explorer source they set is wired then.

**Shared packages.** `require('@qodalis/cli-server-abstractions')`, `@qodalis/cli-server-node` and
`@qodalis/cli-server-plugin-*` from a plugin's files resolve to the server's own copy when it has one (npm still
installs the plugin's dependencies next to it, unused for these), so classes, symbols and the event bus are the
server's. Any other package a plugin requires and did not bring (the marketplace install shares the server's copy and
never installs it) resolves to the server's too. Every server package shares one version: a plugin's range on the core or the abstractions is its server
range.

### Making a plugin installable

Declare a `qodalis` block in `package.json` and export `createPlugin` from a CommonJS entry:

```json
{
  "name": "@acme/cli-server-plugin-tickets",
  "version": "1.2.0",
  "peerDependencies": { "@qodalis/cli-server-abstractions": "^1.0.0-beta.31" },
  "qodalis": {
    "kind": "server",
    "plugin": "tickets",
    "entry": "./dist/plugin.js",
    "title": "Tickets",
    "icon": "🎫",
    "platforms": { "python": "acme-cli-server-plugin-tickets", "dotnet": "Acme.Cli.Plugin.Tickets" }
  }
}
```

```ts
// src/plugin.ts -> dist/plugin.js
import type { CliPluginContext, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliTicketsBuilder } from './builder';

// For builder.addPlugin (the marketplace's record says it for an installed copy) and when it loads (default 50)
export const plugin = { id: 'tickets', package: '@acme/cli-server-plugin-tickets', title: 'Tickets' };
export const order = 50; // CLI_PLUGIN_LOAD_ORDER.DEFAULT

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    // Its settings: a config provider with defaults (the dashboard's Config page, config set tickets.settings.<key>)
    const settings = await context.settings({
        title: 'Tickets',
        settings: [
            { key: 'project', type: 'string', default: 'SUP', requiresRestart: true },
            { key: 'apiToken', type: 'secret', required: true, requiresRestart: true },
        ],
    });
    // A required setting without a value: needs-configuration, nothing registered until it is saved and the server restarts
    const missing = settings.missingRequired();
    if (missing.length) return context.needsConfiguration(missing);
    return new CliTicketsBuilder({ project: String(settings.value('settings', 'project')) }).build(context.eventBus);
}
```

- **The entry** (`qodalis.entry`): relative to the package, inside it, a `.js` or `.cjs` CommonJS file.
- **`createPlugin(context)`** returns a plugin result (anything with `prefix` and `router`: mounted like
  `mountPlugin`), a module (`name` and `processors`: `addModule`), nothing (it registered everything on
  `context.builder`), or a promise of one of them.
- **`CliPluginContext`** (`@qodalis/cli-server-abstractions`): `pluginId`, `packageName`, `version`, `builder`
  (`addProcessor`, `addModule`, `addConfigProvider`, `addDashboardExtension`, `setFileStorageProvider`,
  `addDataExplorerProvider`, `installedPlugins`, ...), `config` (the server's config service), `logger` (prefixed),
  `dataDir` (`<dataDir>/plugin-data/<id>`, created, kept across updates), `serverDataDir`, `eventBus`, `restart`, and
  `settings(options)`: registers a `CliStoredConfigProvider` (id: the plugin's id unless `id` is given; one section
  `settings`, or `sections`) and resolves once its stored values are loaded. Read values with `provider.value(section,
  key)`, at start or on every use; `secret` settings are kept server-side and never returned.
- **The rest of the context**: `source` (`marketplace` or `code`), `options` (the host's code options:
  `builder.addPlugin(entry, options)`; empty from the marketplace), `services` (what plugins share: `users`,
  `users.stores`, `databases`, `public-api`, `portal.section.docs|api`, `data-explorer.policy`) and
  `needsConfiguration(missing)`.
- **Required settings** (`required: true`): without a value the entry returns `context.needsConfiguration(missing)`
  (`settings.missingRequired()` lists them as `<section>.<key>`): the plugin registers nothing, startup goes on, and its
  state is `needs-configuration` with `missing` in `serverPlugins.states()`, `installed.json`, the admin plugin's
  `GET /server/marketplace/installed` and the installed plugins (`GET /api/v1/qcli/plugins/installed`). It runs once
  they are saved (Config page, `config set`) and the server restarts.
- **`qodalis.config`**: the settings the entry asks for, for the marketplace before install (same schema as a
  dashboard plugin's `config`, plus `secret`, `required`, `requiresRestart`, `sensitive`; `needsConfiguration: true`
  when a required setting has no default: "Needs configuration after install"). Generate it with
  `cliPluginConfigManifest(settings)`; the official plugins export `settings` and `npm run sync:plugin-config` writes it.
- **Code only**: a package that cannot run without the host's code declares `"autoInstall": false` and an
  `autoInstallReason`: listed, never installed at runtime; the dashboard shows "needs setup in code". Of the official
  plugins only `admin` (it hosts the dashboard and the marketplace).

### Load order

Code-added and installed plugins load together, sorted by the entry's `order` (or `qodalis.order`; code first on a
tie). `CLI_PLUGIN_LOAD_ORDER` (the same values on the Python and .NET servers):

| Order | | Official plugins |
|---|---|---|
| `AUTH` 10 | the sign-in; requests wait until these are loaded, so the first one is protected | users (users-postgres at 5: its stores, before it) |
| `CONFIG_STORE` 20 | config stores: `builder.replaceConfigStore(store)` moves the providers already on the default store (the AUTH plugins' settings wait for it) | config-redis |
| `CORE` 30 | what others build on | databases, data-explorer (its rules for the sources) |
| `DEFAULT` 50 | everything else | weather, aws, docs, jobs, audit, filesystem*, public-api |
| 60 | after docs and public-api | portal |
| `SOURCE` 70 | data explorer sources | data-explorer-* |

### Installing in code

The same entry and settings from code: `builder.addPlugin(entry, options)` (every official package exports its entry:
`usersPluginEntry`, `databasesPluginEntry`, ...). Options of a setting's key become its default with source and origin
`code`; a saved setting (dashboard, `config set`) overrides it at the next start (origin `setting`); options that are
not settings (a pool, a client, a function) are read by the entry only. Secrets from code are never returned either.

```ts
import { usersPluginEntry } from '@qodalis/cli-server-plugin-users';
import { usersPostgresPluginEntry } from '@qodalis/cli-server-plugin-users-postgres';

const server = createCliServer({
    configure: (builder) =>
        builder
            .addPlugin(usersPluginEntry, { defaultAdminPassword: process.env.ADMIN_PASSWORD })
            .addPlugin(usersPostgresPluginEntry, { connectionString: process.env.DATABASE_URL }),
});
await server.serverPlugins.ready();
```

Plugin settings are kept by the server's config store; while it keeps them in memory (no `config.store`), in
`<dataDir>/plugin-settings.json` (mode 0600), so they survive the restart they wait for. A config entry carries
`origin`: `code`, `setting` or `default` (`source` stays the store kind: `runtime`, `file`, `database`, or `code`).

| Official plugin | From the marketplace and code | Settings |
|---|---|---|
| weather, aws, docs, jobs, audit | yes | weather `defaultLocation`; aws `region`, `profile`, keys (secrets); docs `folder`, `basePath`, `title`, `name`; audit `maxEntries`; jobs its own `jobs` provider |
| filesystem, filesystem-json, filesystem-s3, filesystem-sqlite | yes | folders (required), a JSON file, an S3 bucket (required; keys as secrets), a SQLite file |
| data-explorer-postgres, -mysql, -mssql, -mongo, -redis, -elasticsearch, -sql | yes | one source each: name, connection (a required secret), read-only (default), timeout, rows |
| data-explorer | yes | rules for every source: read-only for all, a row cap, a rate limit |
| users, users-postgres | yes | users (`users-plugin`): root password (secret), protect the server, tokens without expiry, link approval page; users-postgres: connection string (required secret), schema, table prefix |
| config-redis | yes | URL (required secret), key prefix, expiry |
| databases | yes | name, dialect, connection (required secret), migrations folder, apply on startup |
| public-api, portal | yes | public-api: path, title, OpenAPI file, server URL, quota, retention (needs the users plugin); portal (`portal-plugin`): path, name, logo (needs docs or public-api) |
| admin | code only | it hosts the dashboard and the marketplace |

## Dashboard extensions

A plugin can add its own pages to the admin dashboard. It serves an ES module (built with
`@qodalis/cli-server-dashboard-kit`, so it looks like the dashboard) and registers it; the dashboard
lists the page in its navigation for users holding `permission`, loads the module when the page is
opened and mounts it. Contract: [cli-server-dashboard `docs/extensions.md`](https://github.com/qodalis-solutions/cli-server-dashboard/blob/develop/docs/extensions.md).

```ts
cli.builder.addDashboardExtension({
    id: 'billing', // /qcli/admin/x/billing
    title: 'Billing',
    titles: { de: 'Abrechnung' },
    icon: '💳',
    group: 'data', // overview, operations, data, access, system; account: in the account menu (the signed-in user's menu) instead of the sidebar
    permission: 'billing:read',
    entry: '/billing/admin/extension.js', // served by your plugin, same origin
    styles: ['/billing/admin/extension.css'],
});
// or from a plugin result: cli.mountPlugin({ ..., dashboardExtensions: [ ... ] })
```

The admin plugin lists them at `GET /api/v1/qcli/dashboard/extensions` (behind the dashboard's
sign-in). Every page is listed whatever the caller's permissions; the dashboard hides what the user
may not see and the plugin's own API enforces access. Invalid entries fail startup
(`invalid dashboard extension: <reason>`, `dashboard extension already registered: <id>`).

Two optional fields: `widgets` (slots the module fills besides its page: `overview`, cards on the dashboard's
Overview; `palette`, entries of its command palette) and `search` (a path below the page ending where search
text goes, e.g. `/?q=`: the palette offers "Search <title> for …").

### Pages the plugins bring

The dashboard core holds only the server's own pages; every plugin page is a dashboard module
(`@qodalis/cli-dashboard-module-<name>`) that the plugin owning its API embeds and serves at
`/qcli/modules/<id>` (outside the API, so the dashboard loads it without a token):

| Page | Registered by | Permission | Leave it out |
|---|---|---|---|
| Jobs (Overview cards, palette entries, search) | jobs plugin | `jobs:read` | `new CliJobsBuilder().setDashboardDir(false)` |
| Audit (search) | audit plugin (served by the users plugin with the audit plugin it adds) | `audit:read` | `new CliAuditBuilder().setDashboardDir(false)` |
| API tokens | users plugin (not in guard-only mode) | none: each user sees their own | `new CliUsersBuilder().setDashboardDir(false)` |
| Filesystem | the server, with a file storage provider | `files:read` | `builder.setDashboardModuleDir('filesystem', false)` |
| Data explorer | the server, with a data explorer provider | `data:query` | `builder.setDashboardModuleDir('data-explorer', false)` |
| Databases (Overview cards) | databases plugin (at `/qcli/databases`) | `databases:read` | `new CliDatabasesBuilder().setDashboardDir(false)` |

Each package copies its module's build at build/pack time (`npm run copy-dashboard`: the sibling
`cli-server-dashboard/modules/<name>/dist`, else the npm package); a package without the build shows no page.
`setDashboardDir(dir)` / `setDashboardModuleDir(id, dir)` serve another build. A plugin of your own does the same
with `dashboardModulePage(dir, { id, title, ... })` from `@qodalis/cli-server-abstractions` and returns it in its
result's `dashboardPages`.

## Server events

`createCliServer` creates one event bus (`eventBus`). Everything that changes something publishes on it, and the
events WebSocket (`/ws/v1/qcli/events`) is one subscriber of `*` that sends each event to the sockets its audience
allows. The .NET and Python servers publish the same events.

```typescript
import { createCliServer } from '@qodalis/cli-server-node';

const { eventBus } = createCliServer({ /* ... */ });

// React in code: '*', 'job:*' or an exact type
const unsubscribe = eventBus.subscribe('job:failed', async (event) => {
    await alerts.send(`Job ${event.data.jobId} failed: ${event.data.error}`);
});

// Publish your own: data is merged into the message, the audience is never sent
await eventBus.publish('invoice:paid', { invoiceId: 'inv-42', actor: 'alice' }, { permission: 'billing:read' });
```

Each WebSocket message is one flat JSON object: `type`, `timestamp` (ISO 8601 UTC, added unless the publisher set
one) and the publisher's fields (`type` and `timestamp` are reserved). `actor` is the user who caused the change,
when known.

```json
{ "type": "job:completed", "timestamp": "2026-11-06T10:15:00.000Z", "jobId": "cleanup", "executionId": "…", "duration": 1520 }
```

| Audience | Delivered to |
|---|---|
| none (default) | every connected event socket |
| `{ permission: 'jobs:read' }` | sockets whose user has the permission |
| `{ userId: 'u1' }` | sockets of that user |
| both | the user **or** anyone with the permission |

On a server without the users plugin (sockets have no user) every event reaches every socket. In-process
subscribers receive every event. Handlers run in subscription order and `publish` resolves once they all finished;
a handler that throws is logged and never fails the action that published.

| Type | Fields | Audience | Published by |
|---|---|---|---|
| `job:started` | jobId, executionId | `jobs:read` | scheduler |
| `job:completed` | jobId, executionId, duration | `jobs:read` | scheduler |
| `job:failed` | jobId, executionId, error | `jobs:read` | scheduler |
| `job:cancelled`, `job:timed_out` | jobId, executionId | `jobs:read` | scheduler |
| `job:retrying` | jobId, executionId, attempt, maxRetries, delayMs | `jobs:read` | scheduler |
| `job:paused`, `job:resumed`, `job:stopped` | jobId, status (`paused`, `active`, `stopped`) | `jobs:read` | scheduler |
| `job:triggered` | jobId | `jobs:read` | jobs API, MCP `jobs_trigger` |
| `job:updated` | jobId | `jobs:read` | jobs API (`PUT /jobs/{id}`, `maxConcurrentRuns` included) |
| `job:runs-deleted` | jobId, executionId (one run) or count (bulk) | `jobs:read` | jobs API, MCP `jobs_delete_runs` |
| `user:created`, `user:updated`, `user:deleted` | userId, username | `users:read` | users plugin |
| `group:created`, `group:updated`, `group:deleted` | group (its name) | `groups:read` | users plugin |
| `token:created`, `token:revoked` | tokenId, name, userId | `tokens:read` or the owner | users plugin |
| `session:opened`, `session:closed` | userId, username, sessionId | `sessions:read` | users plugin |
| `fs:changed` | action (`upload`, `mkdir`, `delete`, `write`, `move`, `copy`), path, newPath (move/copy) | `files:read` | file storage provider (filesystem API and MCP `fs_*`) |
| `command:executed` | command (the processor name only), success, durationMs, userId | `audit:read` | `/execute`, `/execute/stream`, MCP command tools |
| `audit:recorded` | the audit entry as `GET /audit` returns it | `audit:read` | audit plugin store |
| `log:entry` | the log entry | `logs:read` | admin plugin (with `eventBus`) |
| `config:changed` | provider, section, keys, version, requiresRestart, user | `config:read` | config service (API, `config` command, MCP `config_set`) |

`user:updated` covers profile, password, enabled/disabled and group membership changes; `session:closed` covers
sign-out, expiry and kicks. The control messages `connected`, `disconnect` and `session-kicked` are unchanged.
`eventSocketManager.broadcastMessage(msg)` still sends a raw message; on a protected server a namespaced message
reaches the holders of its namespace's read permission (`job:*` → `jobs:read`, `user:*` → `users:read`, ...).

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

Sources are **read-only by default**: set `readOnly: false` on a source that must write. Per source you can also require permissions (`requiredPermissions`), limit the tables, collections or keys it shows (`allowedObjects`), mask or drop columns (`maskColumns`, `dropColumns`), limit queries per user (`rateLimit`) and gate exports (`exportPermissions`). Every query is written to the audit log as `data_query` unless `audit: false`. See the [data explorer README](plugins/data-explorer/README.md#read-only-sources).

## Security

When the users plugin is mounted (`mountPlugin(usersPlugin)`, or passed as `auth`), every `/api/...` route and WebSocket requires a session or an API token; login, version discovery and capabilities stay public.

| Surface | Permission |
|---|---|
| `GET /commands`, `/commands/stats` | authenticated |
| `POST /execute`, `/execute/stream` | `commands:execute` plus the processor's `requiredPermissions` |
| `POST /api/qcli/mcp` | `commands:execute` (each tool then checks its own) |
| fs `ls` / `cat` / `stat` / `download` | `files:read` |
| fs `upload` / `mkdir` / `rm` | `files:write` |
| data explorer | `data:query` plus the source's `requiredPermissions` |
| jobs read / manage | `jobs:read` / `jobs:manage` |
| events / logs / shell WebSocket | authenticated / `logs:read` / `shell:execute` |
| admin dashboard | `admin:access` |

WebSockets authenticate with a single-use ticket from `POST /api/v1/qcli/sessions/ws-ticket` (`?ticket=<ticket>`). Sockets bound to a session close with 4401 `session ended` on logout, expiry, kick, or when the user is disabled or deleted. Details: [users plugin README](plugins/users/README.md).

### Installs and config changes need sign-in

On a server no auth provider protects (no users plugin, or `protectServer` off), commands run without a caller. Such an anonymous caller is refused what installs code or changes the server's configuration, through `POST /execute`, `/execute/stream` and the MCP endpoint alike:

| Permission | Commands and tools |
|---|---|
| `plugins:install` | `admin plugins install|update|remove` |
| `dashboard:install` | `admin dashboard install|update|remove` (with `--config`) |
| `config:write` | `config set|reset`, the `config_set` MCP tool |
| `server:restart` | `admin restart`, `POST /api/v1/qcli/server/restart` |

The answer is `sign-in required: protect the server (users plugin) or set allowAnonymousAdmin: true (<permissions>)`. Reads stay open (`config list|get`, `config_list`, `config_get`, `admin plugins search|installed`, `admin dashboard search|info`), secrets stay masked. A server nobody else can reach (local development) may opt in with `createCliServer({ allowAnonymousAdmin: true })`; it logs a startup WARNING. `restart.allowAnonymous` still allows restarting alone. The admin plugin's own routes are not affected: its dashboard signs in.

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
| `sessionCheckIntervalMs` | `30000` | Users-mode re-check (max 60000); also re-checks events/logs sockets opened through an external auth adapter, whether or not the shell is enabled |
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

## Use with your app's sign-in

When your application already signs users in (cookies, JWT, an identity provider), the users plugin can take its users from your app instead of its own logins. The browser terminal, the MCP endpoint and the admin dashboard then all use your session.

```typescript
import express from 'express';
import http from 'http';
import { createCliServer } from '@qodalis/cli-server-node';
import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';
import { CliAdminBuilder } from '@qodalis/cli-server-plugin-admin';

// Your app's origin: the browser terminal and the dashboard call the API and open sockets from it
const cli = createCliServer({ allowedOrigins: ['https://app.example.com'] });
const { registry, builder, eventSocketManager, logSocketManager, eventBus } = cli;

const usersPlugin = new CliUsersBuilder()
    // Runs on every CLI request and WebSocket ticket, and again on open sockets (see below)
    .setAuthAdapter(async (req) => {
        const principal = (req as any).user; // set by your auth middleware below
        if (!principal) return null;
        const account = await accounts.findById(principal.sub);
        if (!account) return null;
        return {
            user: { id: account.id, name: account.email, email: account.email, groups: [], disabled: account.disabled, createdAt: 0, updatedAt: 0 },
            permissions: account.cliPermissions, // e.g. ['commands:execute', 'logs:read']
            isAdmin: account.isAdmin,
        };
    })
    // Your app owns accounts and roles: the CLI's user and group endpoints answer 501
    .setReadOnlyUsers()
    .setReadOnlyGroups()
    .build(eventBus);

const adminPlugin = new CliAdminBuilder()
    .setAuthProvider(usersPlugin.serverAuth)
    .setSignInUrl('https://app.example.com/sign-in')
    .build({ registry, eventSocketManager, builder, eventBus });

cli.mountPlugin(adminPlugin);
cli.mountPlugin(usersPlugin); // protects every CLI route and socket

const app = express();
app.use(cookieParser());
app.use(authenticate);   // your sign-in: sets req.user, and lets anonymous requests through
app.use(cli.app);        // after your authentication: the CLI routes, its auth gate and the dashboard

const server = http.createServer(app);
eventSocketManager.attach(server);
logSocketManager.attach(server);
server.listen(8047);
```

The order matters: `createCliServer()` installs its auth gate inside `cli.app`, so your authentication must run before `cli.app` is reached. Mount `cli.app` under your own app (as above) rather than adding your middleware to `cli.app` with `cli.app.use(...)`, which would run after the gate. WebSocket upgrades never pass through Express middleware; they authenticate with tickets (below).

- **The adapter** (`setAuthAdapter`) returns the user for a request, or `null` when it is not signed in. It can be async, so it can load the account, its roles and its disabled state from your database. A user returned with `disabled: true` is refused (401 `account disabled`).
- **Permissions:** a command's `requiredPermissions` are checked against the user's permissions: those in the result's `permissions`, those of the groups the user is in (`user.groups`, from the group store), and every permission when `isAdmin` is set. Running commands needs `commands:execute`, the logs stream needs `logs:read`.
- **WebSockets:** the browser cannot send headers on a WebSocket, so clients first get a single-use ticket (`POST /api/v1/qcli/sessions/ws-ticket` with your session) and connect with `?ticket=`; the web CLI does this by itself. Open sockets are checked again through the adapter, on the ticket request (so `req.user` is set as above), every `shell.sessionCheckIntervalMs` (30 s by default, at most 60 s) and closed with `4401` when the user is gone, disabled, or lost the socket's permission.
- **Read-only stores:** with `setReadOnlyUsers()` / `setReadOnlyGroups()` the CLI's create, update and delete endpoints answer `501` instead of writing; the session response carries `usersReadOnly` / `groupsReadOnly` so clients can hide those commands.
- **Admin dashboard:** with `setAuthProvider(usersPlugin.serverAuth)` and an external adapter the dashboard signs in through your app: `GET /api/v1/qcli/auth/mode` answers `external` with the `setSignInUrl` URL, its own username/password form is off, and your app opens it as `/qcli/admin/#token=<your bearer token>` (a URL fragment, never sent to servers or logs). See [plugins/admin/README.md](plugins/admin/README.md#sign-in-with-the-host-apps-session).

Details: [plugins/users/README.md](plugins/users/README.md#external-auth-adapter).

### The caller in your own code (`getCliCaller`)

Code that a CLI request runs (a processor and the services it calls) reads the authenticated caller with
`getCliCaller()`: `{ userId, userName, permissions, sessionId?, tokenId? }`, the identity your sign-in adapter or
the users plugin established, whether it came from a session, an API token (`tokenId` set, e.g. a terminal linked
with `server add`) or your adapter. It is undefined outside an authenticated CLI request (an unprotected server, a
background job). A command's `requiredPermissions` are checked against the caller's permissions before it runs.

```ts
import { getCliCaller } from '@qodalis/cli-server-node';

class MyCommand extends CliCommandProcessor {
    async handleAsync() {
        const caller = getCliCaller();
        if (!caller) return 'not signed in';
        return `hello ${caller.userName}`;
    }
}
```

## Permission catalog and host tokens

The server keeps a catalog of the permissions it knows: `{ name, description, group, surface }`, `surface` being `cli` (the CLI's routes) or `host` (your application's routes). Core registers the permissions its route policy and commands check (`commands:execute`, `shell:execute`, `http:request`, `files:read`, `files:write`, `data:query`, `jobs:read`, `jobs:manage`, `logs:read`, `admin:access`, `audit:read`, `audit:clear`), the users plugin its 12 when mounted, and you add the permissions your own routes check:

```typescript
const cli = createCliServer({
    configure: (builder) =>
        builder.addPermissions([
            { name: 'rates:read', description: 'Official exchange rates', group: 'Rates' },
            { name: 'banks:read', description: 'Banks and their buy and sell rates', group: 'Rates' },
        ]), // surface 'host' by default; a plugin passes 'cli' as the second argument
});
```

- Names are concrete `resource:action` permissions (lower case, one `:`, no `*`), descriptions one line of 1-200 characters, groups 1-64 characters. An invalid entry throws `invalid permission entry: <name>`; a name already registered (case-insensitive, including one the users plugin owns) throws `permission already registered: <name>` and fails startup. Register at startup only.
- `builder.permissions.all()` lists every `cli` entry in registration order (core, then plugins), then every `host` entry. The users plugin serves it at `GET /api/v1/qcli/permissions`: the entries the caller holds, or all of them with `?all=true` and `users:read`. The dashboard and the web CLI's `token` command build their permission pickers from it.
- The catalog is for choosing, not for validation: CLI tokens, groups and commands keep accepting any permission string.

**Host tokens.** API tokens have an `audience`: `cli` (the default, as before) or `host`. Only your code creates `host` tokens, through `usersPlugin.apiTokens.create(userId, { name, audience: 'host', permissions: ['rates:read'] })`, with `host` catalog entries the user holds. A host token is refused with `403 { "error": "forbidden: host tokens cannot use CLI routes" }` on every CLI route (core's, the MCP endpoint, and every plugin mounted with `mountPlugin`; public routes such as version discovery, capabilities, sign-in and the terminal link are not checked), whether or not the server is protected, and on the sockets: the events and logs sockets answer 403 at the upgrade, the shell closes with 4403 and the same text. It is accepted only by `usersPlugin.requireAuth()`, `usersPlugin.requirePermission(...)` and `usersPlugin.requireHostToken(...)` (which refuses everything but host tokens) on your routes, under `/api` too, and by the [public-api plugin](plugins/public-api/README.md)'s guard, which adds per-account quotas and usage. A host route under `/api` without a guard is reached without an identity and with `req.qcliHostToken === true`, so guard the routes that serve host tokens. Details, the manager's rules and error texts: [users plugin README](plugins/users/README.md#host-tokens-userspluginapitokens).

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
| `jobs_list`, `jobs_get`, `jobs_history` / `jobs_trigger`, `jobs_pause`, `jobs_resume`, `jobs_stop`, `jobs_cancel`, `jobs_delete_runs` | jobs plugin mounted | `jobs:read` / `jobs:manage` |
| `config_list`, `config_get` / `config_set` | always (the `config` command is served by them, not as command tools) | `config:read` / `config:write` |

`readOnly: true` lists and accepts only tools annotated `readOnlyHint: true` (like the MCP client's `QCLI_READ_ONLY`):
`config_set`, `fs_write` and command tools are then refused with `Tool <name> is not available: the MCP endpoint is
read-only`. The allow-list, deny-list, instructions and `readOnly` can change at runtime through the `mcp` config
provider.

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

## Config providers

The server's configuration is read and changed through **config providers** that the server, its plugins and the
host application register: the admin dashboard's Config page, the `config` command and the `config_*` MCP tools all
show what they return. The .NET and Python servers implement the same contract and JSON
(cli-server-dashboard#61).

A provider has sections; a section has entries (settings). A provider is read-only unless it also implements the
writer; each entry says whether it can change (`mutable`) and whether a change needs a restart. Writable settings are
kept in a **config store** and applied again at startup. Every provider may have its own store, some in the app's
JSON settings file, some in a database, some in Redis; the others use the default store (in memory unless set).

### The contract

In `@qodalis/cli-server-abstractions` (re-exported by the server):

```typescript
type CliConfigEntryType = 'string' | 'number' | 'boolean' | 'string[]' | 'enum' | 'secret' | 'json' | 'duration' | 'url';
type CliConfigSource = 'default' | 'file' | 'environment' | 'database' | 'runtime';

interface CliConfigEntry {
    key: string;
    label?: string;              // default: key
    description?: string;
    type: CliConfigEntryType;
    value?: CliConfigValue;      // JSON; a duration is a string such as '30m'
    default?: CliConfigValue;
    source?: CliConfigSource;    // default 'default'
    mutable?: boolean;
    requiresRestart?: boolean;
    sensitive?: boolean;         // every 'secret' is sensitive: its value is never returned
    isSet?: boolean;             // a sensitive entry whose value the provider leaves out
    validation?: { min?: number; max?: number; pattern?: string; options?: string[]; required?: boolean };
    editor?: string;             // a hint for a richer input: 'tags', 'origins', 'textarea', 'cron', 'code', ...
}

interface CliConfigSection {
    id: string;
    title?: string;
    description?: string;
    entries: CliConfigEntry[];
    version?: string;            // writable sections: a change against an older version gets 409
    allowCustomKeys?: boolean;   // free key/value section (the custom provider)
}

interface ICliConfigProvider {
    readonly id: string;                    // lower case: letters, digits, _ and -
    readonly title: string;
    readonly description?: string;
    readonly order?: number;                // default 100
    readonly requiredPermission?: string;   // needed besides config:read / config:write
    getSections(context: CliConfigContext): CliConfigSection[] | Promise<CliConfigSection[]>;
}

interface ICliConfigWriter {               // optional, on the same object
    validate(sectionId: string, changes: Record<string, CliConfigValue>, context: CliConfigContext): CliConfigErrors | Promise<CliConfigErrors>;
    update(sectionId: string, changes: Record<string, CliConfigValue>, expectedVersion: string | undefined,
           context: CliConfigContext): Promise<{ applied: string[]; requiresRestart: boolean; version: string }>;
}

interface CliConfigContext {
    caller?: { userId?: string; userName?: string; permissions?: readonly string[] };
    hasPermission(permission: string): boolean;   // always true on a server without authentication
    via?: 'api' | 'terminal' | 'mcp';
}

type CliConfigErrors = Record<string, string>;   // key -> message
```

`null` in `changes` resets a setting to its default (clears a secret, removes a free key). Before calling the
writer the server checks the permissions, that each key exists (or the section allows custom keys) and is mutable,
and the value's type and rules; then the writer's `validate`, then `update`. A writer throws
`CliConfigConflictError(currentVersion)` for a stale version and `CliConfigValidationError(errors)` for late errors.

Validation, the same on every server:

| Type | Value | `min` / `max` | `pattern` | `options` |
|---|---|---|---|---|
| `string`, `secret` | string | length | the value | allowed values |
| `url` | absolute URL (`scheme://...`) | length | the value | |
| `number` | finite number | value | | |
| `boolean` | `true` / `false` | | | |
| `enum` | one of `options` | | | required |
| `string[]` | array of strings | item count | each item | each item |
| `duration` | `<integer><ms\|s\|m\|h\|d>` (`500ms`, `30s`, `15m`, `12h`, `7d`) | milliseconds | | |
| `json` | any JSON value | | | |

`required` refuses `''` and `[]`, and `null` when there is no default.

### Registering providers

```typescript
import { CliStoredConfigProvider, JsonFileConfigStore } from '@qodalis/cli-server-node';

createCliServer({
    configure: (builder) => {
        builder.setConfigStore(new JsonFileConfigStore('./data/config.json'));
        builder.addConfigProvider(new CliStoredConfigProvider({
            id: 'billing',
            title: 'Billing',
            sections: [{
                id: 'invoices',
                title: 'Invoices',
                settings: [
                    { key: 'dueDays', type: 'number', default: 30, validation: { min: 1, max: 90 }, apply: (v) => (billing.dueDays = v as number) },
                    { key: 'apiKey', type: 'secret', apply: (v) => billing.setKey(v as string | null) },
                    { key: 'region', type: 'string', mutable: false, value: () => billing.region },
                ],
            }],
        }));
    },
});
```

`CliStoredConfigProvider` describes settings in code: the server attaches its store ([which one](#stores)) when the
provider is registered and calls `apply` with every stored value, then after each change (with the default after a
reset).
`provider.value(section, key)` reads a setting, secrets included, for the host's own code. Any object implementing
`ICliConfigProvider` (and `ICliConfigWriter`) works too. Modules bring providers in `configProviders`
(`builder.addModule`), plugin results in `configProviders` (`mountPlugin`). A provider registered under a built-in id
replaces the built-in one.

### Stores

| Store | Source | Where |
|---|---|---|
| `InMemoryConfigStore` (default) | `runtime` | memory: changes apply at once and are lost on restart |
| `JsonFileConfigStore(path)` | `file` | one JSON file, rewritten on every change (temp file + rename, mode 0600) |
| `JsonFileConfigStore(path, { section: 'qcli' })` | `file` | a section of the app's own JSON settings file (like .NET's appsettings.json): `qcli`, or nested as `app.qcli` / `app:qcli`. The file is re-read on every write and only the section replaced: the other keys, their order, the indentation and the file's mode stay |
| `CliDatabaseConfigStore({ connection })` (databases plugin) | `database` | table `QcliConfig` (PostgreSQL, MySQL, SQL Server, SQLite), one row per section, changes in a transaction with the row locked; migration source `qcli-config` |
| `CliRedisConfigStore({ url \| client })` ([config-redis plugin](plugins/config-redis/README.md)) | `database` | one Redis hash per section (`qcli:config:<provider>:<section>`), writes checked against the version by a Lua script |

A store keeps only the values changed from their defaults, with a version per section, keyed by provider and
section: one store can serve several providers. **Each provider can have its own store.** The store a provider gets,
in this order:

1. the host's store for its id: `createCliServer({ config: { stores: { jobs: redisStore } } })` or
   `builder.setConfigStore(redisStore, 'jobs')`;
2. the provider's own: `new CliStoredConfigProvider({ ..., store })` (or `provider.setStore(store)` before it is
   registered), or `setConfigStore(store)` on the builder of the plugin that adds it: `CliJobsBuilder` (`jobs`),
   `CliUsersBuilder` (`users`), `CliPortalBuilder` (`portal`), `CliAdminBuilder` (`logs`);
   `createCustomConfigProvider({ store })`;
3. the default store: `createCliServer({ config: { store } })` or `builder.setConfigStore(store)`;
4. in memory.

```typescript
import { JsonFileConfigStore } from '@qodalis/cli-server-node';
import { CliDatabaseConfigStore, postgresConnection } from '@qodalis/cli-server-plugin-databases';
import { CliRedisConfigStore } from '@qodalis/cli-server-plugin-config-redis';

const database = new CliDatabaseConfigStore({ connection: postgresConnection(pool) });
const server = createCliServer({
    config: {
        store: new JsonFileConfigStore('config/app.json', { section: 'qcli' }),   // every other provider
        stores: {
            jobs: new CliRedisConfigStore({ url: process.env.REDIS_URL }),
            users: database,
            billing: database,                                                      // one store, two providers
        },
    },
});
await server.config.ready();
```

Set the default store before the server is created; a store for an id before that provider is registered (plugins
mounted later can still get one after the server is created). Stored values are applied while the server starts;
`await server.config.ready()` before listening: it waits for every store (its optional `ready`, e.g. a database
store's table) and every provider's values. Versions and conflicts are per store and section, as before. Implement
`ICliConfigStore` (`read(provider, section)`, `write(provider, section, changes, expectedVersion?)`, optional
`describe()` and `ready`) to keep them elsewhere. Secrets are stored as given: keep the file, table or keys readable by
the server only.

Every store says where it keeps the settings with `describe()`: `{ kind, title, detail, persistent }` (`kind`:
`memory`, `file`, `database`, `redis` or `custom`), shown as each stored provider's `store` and as `defaultStore` by
`GET /api/v1/qcli/config`, on the dashboard's Config page and by `config list`. `detail` names the file (relative to
the working directory, or its name only outside it) and its section, the dialect, database name and table
(`PostgreSQL database qcli, table QcliConfig`), or the Redis host, port, database and key prefix, never credentials or
a connection string. A custom store without `describe()` is shown as
`{ "kind": "custom", "title": "Custom store", "detail": "<class name>" }`, persistent unless its `source` is `runtime`.

| Store | `describe()` | `config list` |
|---|---|---|
| `InMemoryConfigStore` | `{ "kind": "memory", "title": "In memory", "detail": "", "persistent": false }` | `In memory` |
| `JsonFileConfigStore` | `{ "kind": "file", "title": "JSON file", "detail": "qcli-demo-config.json", "persistent": true }` | `JSON file (qcli-demo-config.json)` |
| `JsonFileConfigStore` with `section` | `{ "kind": "file", "title": "JSON file", "detail": "config/app.json, section qcli", "persistent": true }` | `JSON file (config/app.json, section qcli)` |
| `CliDatabaseConfigStore` | `{ "kind": "database", "title": "Database", "detail": "PostgreSQL database qcli, table QcliConfig", "persistent": true }` | `Database (PostgreSQL database qcli, table QcliConfig)` |
| `CliRedisConfigStore` | `{ "kind": "redis", "title": "Redis", "detail": "cache:6379/0, prefix qcli:config", "persistent": true }` | `Redis (cache:6379/0, prefix qcli:config)` |

### Built-in providers

| Provider | Order | Sections and settings | Writable |
|---|---|---|---|
| `server` | 0 | `runtime`: platform, platformVersion, version, nodeEnv, pid, hostname, os, startedAt, uptime | no |
| `auth` (admin plugin) | 10 | `admin`: mode (`password`, `users`, `external`), username, defaultCredentials, jwtSecretConfigured, signInUrl | no |
| `host` | 20 | `options`: basePath, cliRoutes, enableShell, shellAuth, trustProxy, maxTableRows, protected; `environment`: the allowed environment variables, secrets masked | no |
| `cors` | 30 | `cors`: mode (read-only), allowedOrigins | allowedOrigins: CORS (in `origins` mode), WebSocket upgrades, the MCP endpoint and CSRF checks follow it at once |
| `mcp` | 40 | `mcp`: enabled, path (read-only), tools, exclude, instructions, readOnly | when MCP is on |
| `filesystem` | 50 | `filesystem`: storage, allowedPaths (read-only), maxUploadBytes | maxUploadBytes |
| `jobs` (jobs plugin) | 60 | `history`: maxAge, maxRunsPerJob, failedMaxAge, failedMaxRunsPerJob, pruneInterval (read-only) | the retention defaults (the next prune applies them) |
| `users` (users plugin) | 70 | `sessions`: sessionTimeout, maxSessionLifetime; `security`: maxLoginAttempts, lockout, minPasswordLength; `access`: protectServer, signIn, allowNonExpiringTokens, apiTokensWithExternalAuth, usersReadOnly, groupsReadOnly (read-only) | sessions and security |
| `logs` (admin plugin) | 80 | `buffer`: capacity (100-100000), minLevel | yes |
| `custom` | 1000 | `custom`: free keys (the admin plugin's former `custom` section) | yes |

The `host` provider lists only an allowlist of environment variables: `QCLI_*`, `NODE_ENV`, `PORT`, `HOST`, `TZ` and
`LANG` (`DEFAULT_ENVIRONMENT_ALLOW`); PATH, session ids, socket paths and the rest stay out. Add names with
`createCliServer({ config: { environment: { allow: ['APP_*', 'REGION'] } } })`, or replace the list with `include`
(`include: ['*']` shows every variable; `exclude`, default `npm_*`, applies after it). A variable that is shown is a
secret (value never returned, `isSet` only) when its name contains SECRET, PASS (PASSWORD, PASSWD, PASSPHRASE), PWD_,
TOKEN, KEY, SESSION, CREDENTIAL, AUTH, PRIVATE, CONN (CONNECTION, CONNSTR), DSN, COOKIE, SALT, SIGNATURE or CERT, in any
case, when it matches a `secrets` pattern (`secrets: ['MY_*']`), or when its value is a URL with credentials
(`scheme://user:password@host`).
The filesystem roots stay read-only on purpose: widening what the server may read is a deployment decision.

Each provider says where its settings come from (`storage`: `{ kind, description, sources }`; a provider sets it with
its optional `storage` property):

| `kind` | Providers | Meaning |
|---|---|---|
| `store` | `cors`, `mcp`, `filesystem`, `jobs`, `users`, `portal`, `logs`, `custom` (every `CliStoredConfigProvider`) | changes are saved to its config store (the provider's `store`) |
| `runtime` | `server` | read from the running server process |
| `options` | `host` (sources `Server options`, `Environment variables`), `auth` | the options the server or plugin was created with |
| `environment`, `configuration` | (the .NET server's `host` lists its IConfiguration sources) | environment variables; the host's configuration |
| `custom` | a provider without `storage` | `Saved by the provider` (a writer) or `Read by the provider` |

### API

Served by the admin plugin (`/api/v1/qcli/config`, behind the dashboard's sign-in; on a protected server the route
also needs `config:read` for GET and `config:write` for PATCH). It replaces the former `GET/PUT /api/v1/qcli/config`.

| Method | Path | Answer |
|---|---|---|
| GET | `/api/v1/qcli/config` | `{ "defaultStore": {...}, "providers": [provider, ...] }`: the store providers use unless they have their own, and the providers the caller may see, by `order` then id, each stored one with its `store` |
| GET | `/api/v1/qcli/config/{provider}` | one provider (with its `store`) |
| PATCH | `/api/v1/qcli/config/{provider}/{section}` | body `{ "changes": { "key": value }, "version": "3" }` (`version` optional) |

```json
{
  "defaultStore": { "kind": "file", "title": "JSON file", "detail": "config/app.json, section qcli", "persistent": true },
  "providers": [
    {
      "id": "cors",
      "title": "CORS",
      "description": "Origins allowed to call the server from a browser and to open its WebSockets",
      "order": 30,
      "writable": true,
      "storage": { "kind": "store", "description": "Changes are saved to its config store", "sources": [] },
      "store": { "kind": "database", "title": "Database", "detail": "PostgreSQL database qcli, table QcliConfig", "persistent": true },
      "sections": [
        {
          "id": "cors",
          "title": "CORS",
          "description": "",
          "mutable": true,
          "version": "2",
          "allowCustomKeys": false,
          "entries": [
            {
              "key": "allowedOrigins", "label": "Allowed origins", "description": "Exact origins ...",
              "type": "string[]", "value": ["https://app.example"], "default": [], "source": "database",
              "mutable": true, "requiresRestart": false, "sensitive": false, "editor": "origins"
            },
            {
              "key": "apiKey", "label": "apiKey", "description": "", "type": "secret", "value": null, "default": null,
              "source": "runtime", "mutable": true, "requiresRestart": false, "sensitive": true, "isSet": true
            }
          ]
        }
      ]
    }
  ]
}
```

Every entry has all of `key`, `label`, `description`, `type`, `value`, `default`, `source`, `mutable`,
`requiresRestart` and `sensitive`; `validation` and `editor` when set; `isSet` for sensitive entries, whose `value`
and `default` are always `null`. A section's `version` is `null` when it is read-only. A provider's `writable` is
true when it implements the writer and the caller holds `config:write`; its `storage` says where its settings come
from (`sources` always present, `[]` when none). A provider that saves to a store (`storage.kind` `store`) has its
`store` (`{ kind, title, detail, persistent }`), in the list and in `GET /config/{provider}`; other providers have
none. `defaultStore` is in the list only.

| PATCH answer | Body |
|---|---|
| 200 | `{ "provider": "cors", "section": { ...as above }, "applied": ["allowedOrigins"], "requiresRestart": false, "version": "3" }` |
| 400 | `{ "error": "validation failed", "errors": { "allowedOrigins": "'x' is not an origin (...)" } }`; also `changes must be a non-empty object`, `version must be a string`, `config provider server is read-only`, `config section users.access is read-only` |
| 403 | `{ "error": "forbidden: missing permission config:write" }` (or the provider's `requiredPermission`) |
| 404 | `{ "error": "unknown config provider: x" }`, `{ "error": "unknown config section: cors.x" }` |
| 409 | `{ "error": "version conflict", "version": "4" }` |

Per-key messages: `unknown setting`, `read-only`, `invalid key: use letters, digits, _, - and .`, and the
validation messages (`must be a number`, `must be at least 1`, `must be one of: a, b`, `is required`, ...).

### Permissions, audit, events, MCP

- **Permissions** (core's catalog, group `Config`): `config:read` to see the providers (secrets stay hidden),
  `config:write` to change them, plus a provider's own `requiredPermission` for both. On a server without
  authentication everything is allowed (the API still needs the dashboard's sign-in).
- **Audit**: every change writes `config.update` to the auth provider's audit log (the users plugin's), or to
  `builder.setConfigAuditStore(store)`: `username`/`actor` the caller (`anonymous` without one), `target`
  `config:<provider>.<section>`, `details` `<provider>.<section>: key1, key2`, `properties`
  `{ provider, section, version, store, via, changes: [{ key, old, new }] }` with secrets as `***` (`null` when unset);
  `store` is the kind of store written (`file`, `database`, `redis`, ...), never its detail.
- **Event**: `config:changed` `{ provider, section, keys, version, requiresRestart, store, user }` (`store`: the
  kind written), audience `config:read`, never values: open dashboards reload the provider.
- **MCP** (when `mcp` is on): `config_list` (the default store, providers with their `storage` and `store`, and section summaries) and `config_get` (`provider`,
  `section?`, `key?`), read-only, need `config:read`; `config_set` (`provider`, `section`, `changes`, `version?`)
  needs `config:write` and is not read-only, so the MCP client's `QCLI_READ_ONLY` and the endpoint's own
  `mcp: { readOnly: true }` hide and refuse it. Errors come back as `isError` with `{ error, errors?, version? }`.

## Restart

Some changes take effect only after a restart: a setting with `requiresRestart`, a plugin installed later. The server
keeps the list of them and can restart itself, from the dashboard, `admin restart --yes` (admin plugin) or the API.

```ts
const server = createCliServer({
    // 'auto' (default): 'exit' under a detected supervisor, else not supported
    // 'exit': exit with exitCode (default 75) for Docker (restart policy), systemd (Restart=always), PM2 or Kubernetes
    // 'self': start the same command again (same arguments, environment, working directory, stdout/stderr), then exit
    // 'handler': your function, after the graceful shutdown
    restart: { mode: 'self' },
});
server.restart.markRequired({ id: 'plugin:tickets', source: 'tickets', description: 'Tickets plugin installed' });
server.restart.clearRequired('plugin:tickets');
server.restart.onShutdown('pool', () => pool.end()); // your own clean-up, in registration order
```

- **Pending list**: `markRequired({ id, source, description })` (once per id), `clearRequired(id)`; empty after every
  start. The config service marks a changed entry with `requiresRestart` as `config:<provider>.<section>.<key>`
  (source `config`, `CORS: Mode changed`) and clears it when the value is set back to what it was at start.
- **Supervisor detection** (`auto`): PM2 (`pm_id`), systemd (`INVOCATION_ID`), Kubernetes (`KUBERNETES_SERVICE_HOST`,
  `kubepods` in `/proc/1/cgroup`), Docker (`/.dockerenv`, `docker` in `/proc/1/cgroup`). Without one, restarting is not
  supported until `restart.mode` is set.
- **Graceful shutdown**: stop accepting connections, wait for in-flight requests (up to `drainTimeoutMs`, 10 s),
  close every WebSocket (events, logs, shell) with **1012** (service restart), then the hooks: mounted job schedulers
  stop, mounted plugins' `dispose()`, `onShutdown` functions. The HTTP server is the one `eventSocketManager.attach(server)`
  got (or the one serving the requests).
- **`self`** re-runs `process.execPath` with `process.execArgv` and `process.argv` (so `tsx`, `node --import ...`
  keep working), detached, stdin ignored, stdout and stderr inherited: under `nohup ... >> server.log` the new process
  appends to the same file. This process then exits 0.
- **Sign-in**: on a server without an auth provider protecting it, restarting is refused (403) unless
  `restart.allowAnonymous` or `allowAnonymousAdmin` is set.

| Route | Permission | Does |
|---|---|---|
| `GET /api/v1/qcli/server/restart` | `admin:access` | The status below |
| `POST /api/v1/qcli/server/restart` `{ reason? }` | `server:restart` | 202 `{ restarting: true, pending: [ids] }`, then the restart; 409 `{ error: 'restart not supported: no supervisor detected; set restart.mode' }` or `restart already in progress`; 403 without sign-in |

```json
{
  "supported": true,
  "mode": "self",
  "supervisor": null,
  "startedAt": "2026-11-25T10:00:00.000Z",
  "pending": [
    { "id": "config:cors.cors.mode", "source": "config", "description": "CORS: Mode changed", "since": "2026-11-25T10:04:05.000Z" }
  ]
}
```

`mode` is the mode in effect (`auto` shows `exit`), null when not supported, with `reason`
(`no supervisor detected; set restart.mode`). `startedAt` changes once the server is back: poll it (or
`GET /api/qcli/versions`) to know when.

- **Permission** `server:restart` (core catalog, group `Server`).
- **Audit** `server.restart`: `target` `server`, `details` the reason, `properties` `{ reason, by, pending, mode, supervisor, via }`.
- **Events** (audience `admin:access`): `server:restart-required` `{ pending }` whenever the list changes,
  `server:restarting` `{ reason, by, pending, mode }` before the shutdown.

## Terminal commands

The server registers `config` (leave it out with `createCliServer({ config: { command: false } })`); plugins add
theirs (`databases`, ...). Paths are `<provider>.<section>.<key>`: the provider id has no dots, the section is the
longest section id that matches, the rest is the key.

| Command | Permission | Does |
|---|---|---|
| `config`, `config list` | `config:read` | The default store, then the providers (each stored one with its store) and their sections (setting count, version) |
| `config get <provider>[.<section>[.<key>]]` | `config:read` | A provider, a section, or one setting with its default, source, rules and version |
| `config set <provider>.<section>.<key> <value> [--expected-version v]` | `config:write` | Changes a setting; a stale `--expected-version` is refused (not `--version`: the web CLI answers that flag itself) |
| `config reset <provider>.<section>.<key> [--expected-version v]` | `config:write` | Back to the default (clears a secret, removes a free key) |

Values are read as the setting's type: numbers, `true`/`false`/`yes`/`no`/`on`/`off`, lists as `a,b,c` or a JSON
array, `json` as JSON; a new key of the custom section as JSON when it parses, else as text. Validation errors are
printed per key; secrets are accepted and never printed (`(set)` / `(not set)`).

```text
$ config list
Default store: JSON file (config/app.json, section qcli), kept across restarts
server  Server  (read-only)
  runtime            9 setting(s)
cors  CORS  · JSON file (config/app.json, section qcli)
  cors               2 setting(s)  version 0
jobs  Jobs  · Redis (cache:6379/0, prefix qcli:config)
  history            5 setting(s)  version 3
custom  Custom  · Database (PostgreSQL database qcli, table QcliConfig)
  custom             0 setting(s)  version 0

$ config get cors.cors
cors.cors  CORS  (version 0)
  mode            origins  [enum, default, read-only]
  allowedOrigins  []  [string[], default]

$ config set cors.cors.allowedOrigins https://app.example,http://localhost:*
Updated cors.cors.allowedOrigins = ["https://app.example","http://localhost:*"] (version 1)

$ config set users.sessions.sessionTimeout 10s
Error: validation failed
  sessionTimeout: must be at least 1m

$ config set cors.cors.allowedOrigins https://other.example --expected-version 0
Error: version conflict (current version 1)

$ config set custom.custom.stripeKey sk_live_123
Updated custom.custom.stripeKey = sk_live_123 (version 1)

$ config reset cors.cors.allowedOrigins
Reset cors.cors.allowedOrigins = [] (version 2)
```

(A free key of the `custom` section is not a secret: keep secrets in a provider that declares them `secret`.)

### Plugin commands

Every plugin README has a `Terminal commands` section. Commands served by this server (registered by `mountPlugin`
or `addModule`; permissions enforced on a protected server, along the command chain):

| Plugin | Commands | Permission |
|---|---|---|
| [admin](plugins/admin/README.md#terminal-commands) | `admin status [--history]`, `admin plugins [list\|enable\|disable <id>]`, `admin clients`, `admin logs [--level] [--search] [--service] [--since] [-n]` | `admin:access`; `logs` also `logs:read` |
| [databases](plugins/databases/README.md#terminal-commands) | `databases list\|stats\|migrations\|runs\|up\|down` | `databases:read`; `up`/`down` `databases:migrate` |
| [docs](plugins/docs/README.md#terminal-commands) | `docs list [--group]`, `docs read <slug>` | none |
| [public-api](plugins/public-api/README.md#terminal-commands) | `api usage [--user <name\|id>] [--days N]` | none for your own; `tokens:read` for another account |
| [aws](plugins/aws/README.md#terminal-commands) | `aws configure\|status\|s3\|ec2\|lambda\|cloudwatch\|sns\|sqs\|iam\|ecs\|dynamodb ...` | `aws:read`; changes also `aws:write` |
| [weather](plugins/weather/README.md#terminal-commands) | `weather [current\|forecast] [location]` | none |

Lists take `--json`. Plugins driven by web CLI plugins: jobs (`server jobs ...`, `@qodalis/cli-server-jobs`), users
and audit (`adduser`, `token`, `link approve`, `audit`, ..., `@qodalis/cli-users`), data explorer (`data-explorer`,
`@qodalis/cli-data-explorer`), filesystem (`scp`, `@qodalis/cli-scp`), live logs (`server logs`,
`@qodalis/cli-server-logs`). Commands a module declares can bring their permissions to the catalog:
`ICliModule.permissions` (`{ name, description, group }`, added by `addModule` with surface `cli`).

## Built-in processors

| Command | Description | Permission |
|---|---|---|
| `http` | HTTP `get` / `post` requests sent from the server (module `core`) | `http:request` |

Hosts opt in: `builder.addProcessor(new CliHttpCommandProcessor())` (the standalone server adds it). `http:request` is in
core's permission catalog (group Commands); on a protected server the command and its sub-commands are refused without it.

The example commands `echo`, `status`, `time`, `hello`, `math`, `system`, `hash` and `base64` live in the demo app
([demo/src/demo-module.ts](demo/src/demo-module.ts)), registered as the `demo` module.

A command added with `addModule` is listed by `GET /api/v1/qcli/commands` under the module's name (`module`) unless it
names a module itself, so the dashboard's Plugins page groups it with its module.

Each command, and each sub-command in `processors`, lists the permissions it declares itself as `requiredPermissions`;
the field is left out when it declares none. Running a command also needs the permissions of the commands above it and,
on a protected server, `commands:execute`; neither is repeated:

```json
{
  "command": "aws",
  "module": "aws",
  "requiredPermissions": ["aws:read"],
  "processors": [
    {
      "command": "s3",
      "processors": [
        { "command": "ls" },
        { "command": "rm", "requiredPermissions": ["aws:write"] }
      ]
    }
  ]
}
```

## Docker

```bash
docker run -p 8047:8047 ghcr.io/qodalis-solutions/cli-server-node
```

The image runs the standalone server and accepts the same environment variables. `docker-compose.yml` builds and runs the demo server (`demo/Dockerfile`) on port 8047.

## Versioning

Every package in this repository (`@qodalis/cli-server-node`, `@qodalis/cli-server-abstractions` and every `@qodalis/cli-server-plugin-*`) has the same version, and so do the .NET and Python servers' packages: `1.0.0-beta.33` today. A release bumps all of them together, even packages that did not change, so one version number describes a whole server release. Install the same version of every `@qodalis/cli-server-*` package you use.

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
| `src/` | Server factory, controllers, services, MCP, the built-in `http` command, standalone entry (`server.ts`) |
| `packages/abstractions/` | `@qodalis/cli-server-abstractions` |
| `plugins/` | Plugin packages (users, admin, jobs, filesystem, data explorer, aws, weather) |
| `demo/` | Demo server with custom processors and every plugin |

## License

[MIT](LICENSE)
