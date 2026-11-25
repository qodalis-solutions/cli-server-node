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
| `ICliConfigProvider` | A config provider: `id`, `title`, `description?`, `order?` (default 100), `requiredPermission?`, `getSections(context)` |
| `ICliConfigWriter` | The optional write side of a provider: `validate(sectionId, changes, context)` → per-key errors, `update(sectionId, changes, expectedVersion, context)` → `{ applied, requiresRestart, version }` |
| `CliConfigSection`, `CliConfigEntry`, `CliConfigValidation` | A section (`id`, `title?`, `entries`, `version?`, `allowCustomKeys?`) and a setting (`key`, `type`, `value`, `default`, `source`, `mutable`, `requiresRestart`, `sensitive`, `isSet`, `validation`, `editor`) |
| `CliConfigEntryType`, `CliConfigSource`, `CliConfigValue` | `string`, `number`, `boolean`, `string[]`, `enum`, `secret`, `json`, `duration`, `url`; `default`, `file`, `environment`, `database`, `runtime`; a JSON value |
| `CliConfigContext` | Who reads or changes: `caller?`, `hasPermission(permission)`, `via?` (`api`, `terminal`, `mcp`) |
| `ICliConfigStore`, `CliConfigStoredSection` | Where writable settings are kept: `source`, `read(provider, section)`, `write(provider, section, changes, expectedVersion?)`, optional `describe()` and `ready` (a promise or a function the server's `config.ready()` waits for); `{ values, version }`. Each provider may have its own; one store may serve several providers (keyed by provider and section) |
| `CliConfigStoreDescription`, `CliConfigStoreKind` | What a store says about itself: `{ kind, title, detail, persistent }`, `kind` `memory`, `file`, `database`, `redis` or `custom`; never credentials |
| `ICliConfigService` | The server's config service (`list`, `get`, `update`, `describeDefaultStore()`), served by the admin plugin |
| `CliConfigProviderView`, `CliConfigSectionView`, `CliConfigEntryView`, `CliConfigListView`, `CliConfigUpdateRequest`, `CliConfigUpdateResponse` | The JSON of `GET /api/v1/qcli/config` (`{ defaultStore, providers }`, each stored provider with its `store`) and `PATCH /api/v1/qcli/config/{provider}/{section}` |
| `ICliModule.configProviders` | Config providers a module brings, registered with it |

### Classes

| Class | Description |
|-------|-------------|
| `CliCommandProcessor` | Abstract base class implementing `ICliCommandProcessor` with sensible defaults |
| `CliCommandAuthor` | Simple implementation of `ICliCommandAuthor` |
| `CliCommandParameterDescriptor` | Simple implementation of `ICliCommandParameterDescriptor` |
| `CliPaging` | `--skip` / `--take` convention: `CliPaging.parameters()` and `CliPaging.from(command)` |
| `CliStoredConfigProvider` | A provider of settings described in code (`sections[].settings[]` with `default`, `validation`, `validate`, `apply`, `value`); `value(section, key)` for the host's code. Changes are kept in its store: the host's store for its id, else its own (option `store`, `setStore(store)`; `ownStore`), else the server's default store, else memory; `store` is the one in use |
| `InMemoryConfigStore`, `JsonFileConfigStore`, `JsonFileConfigStoreOptions` | Config stores in memory (source `runtime`) and in a JSON file (source `file`, mode 0600), or with `{ section: 'qcli' }` in a section of the app's own JSON settings file (nested `app.qcli` or `app:qcli`; the rest of the file kept as it is); `describe()` says where they keep the settings (`config/app.json, section qcli`) |
| `describeCliConfigStore`, `describeCliConfigStoreLine`, `describeCliConfigStoreName` | A store's description (`custom` for a store without `describe()`), its `Default store:` line and its name in `config list` (`Redis (cache:6379/0, prefix qcli:config)`) |
| `CliConfigError` | A refused read or change: `status` (400, 403, 404, 409), `toJSON()` → `{ error, errors?, version? }` |
| `CliConfigConflictError`, `CliConfigValidationError` | Thrown by writers and stores: a stale version (`currentVersion`), late per-key errors |

### Constants

| Constant | Description |
|----------|-------------|
| `DefaultLibraryAuthor` | Default `ICliCommandAuthor` instance used when no author is specified |
| `DEFAULT_TAKE`, `MAX_TAKE` | Rows shown by default (50) and at most (500) |
| `CliEventPermissions` | The read permissions of the server events' audiences (`jobs:read`, `users:read`, ...) |
| `CliConfigPermissions` | `config:read`, `config:write` |
| `CLI_CONFIG_CHANGED_EVENT`, `CLI_CONFIG_AUDIT_EVENT` | `config:changed` (event, audience `config:read`), `config.update` (audit) |

### Functions

| Function | Description |
|----------|-------------|
| `pruneAudit(store, before)` | Deletes the audit entries recorded before `before` (`store.prune`); 0 for a store that keeps everything |
| `cliEventPatternMatches(type, pattern)` | `*` matches everything, `ns:*` every type starting with `ns:`, else exact |
| `toCliEventMessage(event)` | The flat wire message `{ type, timestamp, ...data }` |
| `cliEventBusFromBroadcast(fn)`, `resolveCliEventBus(busOrFn)` | A bus over a raw broadcast function (for plugins built with one) |
| `validateCliConfigValue(entry, value)` | The error message of a new value (type and `validation` rules), or undefined; the same rules on every server |
| `parseCliConfigInput(type, text)` | A value typed in the terminal as the entry's type (numbers, booleans, `a,b` lists, JSON) |
| `parseCliConfigDuration(text)`, `formatCliConfigDuration(ms)` | `30m` ↔ 1800000 (`ms`, `s`, `m`, `h`, `d`) |
| `createCustomConfigProvider(options?)` | The `custom` provider: one free key/value section (`store` option: its own store) |
| `cliConfigContext(caller?, via?)`, `hasCliPermission(granted, required)` | A context from a caller's permissions (no caller: everything allowed); wildcard permission matching |

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

## Config providers

The server's configuration is read and changed through providers (the admin dashboard's Config page, the server's
`config` command and the `config_*` MCP tools). A plugin brings its settings like this:

```typescript
import { CliStoredConfigProvider, ICliModule } from '@qodalis/cli-server-abstractions';

const settings = new CliStoredConfigProvider({
    id: 'weather',
    title: 'Weather',
    sections: [{
        id: 'api',
        settings: [
            { key: 'units', type: 'enum', default: 'metric', validation: { options: ['metric', 'imperial'] }, apply: (v) => (client.units = v as string) },
            { key: 'apiKey', type: 'secret', apply: (v) => client.setKey(v as string | null) },
            { key: 'cacheFor', type: 'duration', default: '10m', validation: { min: 60_000 } },
        ],
    }],
});

export const weatherModule: ICliModule = { name: 'weather', version: '1.0.0', description: 'Weather', author, processors, configProviders: [settings] };
```

Secrets are never returned by the server (only `isSet`); `null` resets a setting to its default. The JSON, the
validation rules, permissions, audit and events are described in the
[server README](https://github.com/qodalis-solutions/cli-server-node#config-providers).

## License

MIT
