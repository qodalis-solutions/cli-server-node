# @qodalis/cli-server-abstractions

Shared interfaces and base classes for building [Qodalis CLI](https://qodalis.com/) command processors. **Zero framework dependencies** — install this package when writing plugins, without pulling in Express, cors, or ws.

## Install

```bash
npm install @qodalis/cli-server-abstractions
```

## Quick Start

Create a custom command processor by extending `CliCommandProcessor`:

```typescript
import {
    CliCommandProcessor,
    CliProcessCommand,
    CliCommandParameterDescriptor,
} from '@qodalis/cli-server-abstractions';

export class GreetCommandProcessor extends CliCommandProcessor {
    command = 'greet';
    description = 'Greets a user by name';
    parameters = [
        new CliCommandParameterDescriptor('--name', 'Name to greet', true),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const name = command.args['name'] || 'World';
        return `Hello, ${name}!`;
    }
}
```

Then register the processor with the server package. See [`@qodalis/cli-server-node`](https://www.npmjs.com/package/@qodalis/cli-server-node) for server setup.

## API Reference

### Interfaces

| Interface | Description |
|-----------|-------------|
| `ICliCommandProcessor` | Contract for command processors: command name, description, author, parameters, sub-processors, and `handleAsync()` |
| `ICliCommandAuthor` | Author metadata: `name` and `email` |
| `ICliCommandParameterDescriptor` | Parameter declaration: name, type, required flag, aliases, default value |
| `CliProcessCommand` | Parsed command input: command name, value, args, chain commands, raw input, data payload |
| `CliPageRequest` | The rows a list command was asked for: `skip`, `take` |
| `CliTablePage` | The `page` of a table output: `skip`, `take`, `total?`, `hasMore`, `truncated?` |
| `ICliAuditStore` | Where the audit log is kept (`log`, `getEntries`, `clear`, optional `prune`); the audit plugin keeps it in memory by default |
| `AuditEntry`, `AuditMetadata`, `AuditQueryOptions` | An audit log entry, its request details, and the filters/paging of a query |
| `ICliEventBus` | The server's event bus: `publish(type, data?, audience?)` (never rejects) and `subscribe(pattern, handler)` → unsubscribe |
| `CliEvent`, `CliEventAudience` | An event (`type`, `timestamp`, `data`, `audience`) and who receives it over the events WebSocket (`permission`, `userId`) |

### Classes

| Class | Description |
|-------|-------------|
| `CliCommandProcessor` | Abstract base class implementing `ICliCommandProcessor` with sensible defaults |
| `CliCommandAuthor` | Simple implementation of `ICliCommandAuthor` |
| `CliCommandParameterDescriptor` | Simple implementation of `ICliCommandParameterDescriptor` |
| `CliPaging` | `--skip` / `--take` convention: `CliPaging.parameters()` and `CliPaging.from(command)` |

### Constants

| Constant | Description |
|----------|-------------|
| `DefaultLibraryAuthor` | Default `ICliCommandAuthor` instance used when no author is specified |
| `DEFAULT_TAKE`, `MAX_TAKE` | Rows shown by default (50) and at most (500) |
| `CliEventPermissions` | The read permissions of the server events' audiences (`jobs:read`, `users:read`, ...) |

### Functions

| Function | Description |
|----------|-------------|
| `pruneAudit(store, before)` | Deletes the audit entries recorded before `before` (`store.prune`); 0 for a store that keeps everything |
| `cliEventPatternMatches(type, pattern)` | `*` matches everything, `ns:*` every type starting with `ns:`, else exact |
| `toCliEventMessage(event)` | The flat wire message `{ type, timestamp, ...data }` |
| `cliEventBusFromBroadcast(fn)`, `resolveCliEventBus(busOrFn)` | A bus over a raw broadcast function (for plugins built with one) |

### `CliCommandProcessor` Members

| Member | Type | Default | Description |
|--------|------|---------|-------------|
| `command` | `string` | *(abstract)* | The command name users type to invoke this processor |
| `description` | `string` | *(abstract)* | Human-readable description shown in help |
| `author` | `ICliCommandAuthor` | `DefaultLibraryAuthor` | Author metadata |
| `version` | `string` | `'1.0.0'` | Processor version |
| `allowUnlistedCommands` | `boolean?` | `undefined` | Accept sub-commands not in `processors` list |
| `valueRequired` | `boolean?` | `undefined` | Whether a positional value argument is required |
| `processors` | `ICliCommandProcessor[]?` | `undefined` | Nested sub-command processors |
| `parameters` | `ICliCommandParameterDescriptor[]?` | `undefined` | Declared parameters for autocompletion and validation |
| `handleAsync(command)` | method | *(abstract)* | Execute the command, return result string |

## License

MIT
