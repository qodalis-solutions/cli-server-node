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

### Classes

| Class | Description |
|-------|-------------|
| `CliCommandProcessor` | Abstract base class implementing `ICliCommandProcessor` with sensible defaults |
| `CliCommandAuthor` | Simple implementation of `ICliCommandAuthor` |
| `CliCommandParameterDescriptor` | Simple implementation of `ICliCommandParameterDescriptor` |

### Constants

| Constant | Description |
|----------|-------------|
| `DefaultLibraryAuthor` | Default `ICliCommandAuthor` instance used when no author is specified |

### `CliCommandProcessor` Members

| Member | Type | Default | Description |
|--------|------|---------|-------------|
| `command` | `string` | *(abstract)* | The command name users type to invoke this processor |
| `description` | `string` | *(abstract)* | Human-readable description shown in help |
| `author` | `ICliCommandAuthor` | `DefaultLibraryAuthor` | Author metadata |
| `version` | `string` | `'1.0.0'` | Processor version |
| `apiVersion` | `number` | `1` | Minimum API version this processor targets |
| `allowUnlistedCommands` | `boolean?` | `undefined` | Accept sub-commands not in `processors` list |
| `valueRequired` | `boolean?` | `undefined` | Whether a positional value argument is required |
| `processors` | `ICliCommandProcessor[]?` | `undefined` | Nested sub-command processors |
| `parameters` | `ICliCommandParameterDescriptor[]?` | `undefined` | Declared parameters for autocompletion and validation |
| `handleAsync(command)` | method | *(abstract)* | Execute the command, return result string |

## License

MIT
