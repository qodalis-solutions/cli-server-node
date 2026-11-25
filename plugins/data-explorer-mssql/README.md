# @qodalis/cli-server-plugin-data-explorer-mssql

Microsoft SQL Server data explorer provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Connects to a SQL Server instance and executes T-SQL queries with schema introspection support.

## Install

```bash
npm install @qodalis/cli-server-plugin-data-explorer-mssql
```

## Quick Start

```typescript
import {
    DataExplorerBuilder,
    createDataExplorerController,
    DataExplorerExecutor,
} from '@qodalis/cli-server-plugin-data-explorer';
import { MssqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-mssql';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const deBuilder = new DataExplorerBuilder()
    .addProvider(
        new MssqlDataExplorerProvider({
            connectionString: 'Server=localhost;Database=mydb;User Id=sa;Password=secret;',
        }),
        {
            name: 'mssql',
            description: 'SQL Server database',
            language: DataExplorerLanguage.Sql,
            defaultOutputFormat: DataExplorerOutputFormat.Table,
        },
    );

const executor = new DataExplorerExecutor(deBuilder.registry);
app.use('/api/v1/qcli/data-explorer', createDataExplorerController(deBuilder.registry, executor));
```

## Configuration

| Option | Type | Description |
|---|---|---|
| `connectionString` | `string` | SQL Server connection string |

## Features

- Execute any T-SQL query and receive tabular results.
- Schema introspection lists all tables and views in the `dbo` schema with column names, data types, nullability, and identity column detection.

## Dependencies

- `mssql`

## Terminal commands

None of its own: the provider is queried through the [data explorer plugin](../data-explorer/README.md#terminal-commands)
(`data-explorer` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install data-explorer-mssql`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) adds one SQL Server source to the data explorer from its settings.

| Setting | Type | Default | |
|---|---|---|---|
| `name` | string | `mssql` | The source name in the data explorer |
| `description` | string | the engine name |  |
| `connectionString` | secret | — | `Server=host;Database=db;User Id=user;Password=...;` |
| `readOnly` | boolean | `true` | Queries may only read |
| `timeoutMs` | number | `30000` | 1000-600000 |
| `maxRows` | number | `1000` | 1-100000 |

Every setting needs a restart. Set them with `config set data-explorer-mssql.settings.<key> <value>` or the Config page, then restart: until
the connection is set, no source is added (a warning is logged). The connection is a `secret` setting: kept by the
server's config store, never returned by the API (`isSet` only). The database driver comes with the package.

## License

MIT
