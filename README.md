# Qodalis CLI Server (Node.js)

A Node.js CLI server framework for the [Qodalis CLI](https://github.com/qodalis-solutions/angular-web-cli) ecosystem. Build custom server-side commands that integrate with the Qodalis web terminal.

## Installation

```bash
npm install @qodalis/cli-server-node
```

The package exports all types, interfaces, base classes, and built-in processors. TypeScript declarations are included.

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
// Abstractions (for creating custom processors)
import {
    ICliCommandProcessor,
    CliCommandProcessor,
    ICliCommandParameterDescriptor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandAuthor,
    CliCommandAuthor,
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
src/
  abstractions/
    cli-command-processor.ts          # ICliCommandProcessor interface & base class
    cli-process-command.ts            # Command input model
    cli-command-parameter-descriptor.ts  # Parameter declaration
    cli-command-author.ts             # Author metadata
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
    cli-builder.ts                    # Fluent registration API
  processors/                         # Built-in processors
  create-cli-server.ts               # Factory function
  server.ts                          # Standalone CLI entry point
  index.ts                           # Package exports
demo/                                # Demo app with sample processors
```

## License

MIT
