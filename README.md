# Qodalis CLI Server (Node.js)

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

## API Versioning

Processors declare which API version they target. The default is version 1.

```typescript
class DashboardProcessor extends CliCommandProcessor {
    command = 'dashboard';
    description = 'Server dashboard (v2 only)';
    apiVersion = 2;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return 'Dashboard data...';
    }
}
```

The server exposes versioned endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cli/versions` | Version discovery (supported versions, preferred version) |
| GET | `/api/v1/cli/version` | V1 server version |
| GET | `/api/v1/cli/commands` | V1 commands (all processors) |
| POST | `/api/v1/cli/execute` | V1 execute |
| GET | `/api/v2/cli/version` | V2 server version |
| GET | `/api/v2/cli/commands` | V2 commands (only `apiVersion >= 2`) |
| POST | `/api/v2/cli/execute` | V2 execute |
| WS | `/ws/cli/events` | WebSocket events (also `/ws/v1/cli/events`, `/ws/v2/cli/events`) |

The Qodalis CLI client auto-negotiates the highest mutually supported version via the `/api/cli/versions` discovery endpoint.

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
| `apiVersion` | `number` | `1` | Target API version |
| `author` | `ICliCommandAuthor` | default author | Author metadata (name, email) |

## Server Options

```typescript
interface CliServerOptions {
    basePath?: string;                     // API base path (default: '/api/cli')
    cors?: boolean | cors.CorsOptions;     // CORS config (default: false)
    configure?: (builder: CliBuilder) => void;  // Processor registration
}
```

`createCliServer()` returns:

```typescript
{
    app: Express;                          // Configured Express app
    registry: CliCommandRegistry;          // Processor registry
    builder: CliBuilder;                   // Registration builder
    eventSocketManager: CliEventSocketManager;  // WebSocket manager
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

The server includes a pluggable file storage system exposed at `/api/cli/fs/*`. Enable it with `setFileStorageProvider()` and choose a storage backend.

### Filesystem API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cli/fs/ls?path=/` | List directory contents |
| GET | `/api/cli/fs/cat?path=/file.txt` | Read file content |
| GET | `/api/cli/fs/stat?path=/file.txt` | File/directory metadata |
| GET | `/api/cli/fs/download?path=/file.txt` | Download file |
| POST | `/api/cli/fs/upload` | Upload file (multipart) |
| POST | `/api/cli/fs/mkdir` | Create directory |
| DELETE | `/api/cli/fs/rm?path=/file.txt` | Delete file or directory |

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
| `uuid` | UUID generation |

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
  filesystem/                         # Core file storage abstraction (IFileStorageProvider, InMemory, OS)
  filesystem-json/                    # JSON file persistence provider
  filesystem-sqlite/                  # SQLite persistence provider (better-sqlite3)
  filesystem-s3/                      # Amazon S3 storage provider (@aws-sdk/client-s3)
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
  controllers/
    cli-controller.ts                 # V1 REST API (/api/v1/cli)
    cli-controller-v2.ts              # V2 REST API (/api/v2/cli)
    cli-version-controller.ts         # Version discovery (/api/cli/versions)
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
