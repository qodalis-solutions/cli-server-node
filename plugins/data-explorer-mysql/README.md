# @qodalis/cli-server-plugin-data-explorer-mysql

MySQL data explorer provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Connects to a MySQL database and executes SQL queries with schema introspection support.

## Install

```bash
npm install @qodalis/cli-server-plugin-data-explorer-mysql
```

## Quick Start

```typescript
import {
    DataExplorerBuilder,
    createDataExplorerController,
    DataExplorerExecutor,
} from '@qodalis/cli-server-plugin-data-explorer';
import { MysqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-mysql';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const deBuilder = new DataExplorerBuilder()
    .addProvider(
        new MysqlDataExplorerProvider({
            connectionString: 'mysql://root:password@localhost:3306/mydb',
        }),
        {
            name: 'mysql',
            description: 'MySQL database',
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
| `connectionString` | `string` | MySQL connection URI |

## Features

- Execute any SQL query and receive tabular results.
- Schema introspection lists all tables and views in the current database with column names, data types, nullability, and primary key detection.

## Dependencies

- `mysql2`

## Terminal commands

None of its own: the provider is queried through the [data explorer plugin](../data-explorer/README.md#terminal-commands)
(`data-explorer` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install data-explorer-mysql`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) adds one MySQL source to the data explorer from its settings.

| Setting | Type | Default | |
|---|---|---|---|
| `name` | string | `mysql` | The source name in the data explorer |
| `description` | string | the engine name |  |
| `connectionString` | secret | — | `mysql://user:password@host:3306/database` |
| `readOnly` | boolean | `true` | Queries may only read |
| `timeoutMs` | number | `30000` | 1000-600000 |
| `maxRows` | number | `1000` | 1-100000 |

Every setting needs a restart. Set them with `config set data-explorer-mysql.settings.<key> <value>` or the Config page, then restart: until
the connection is set the plugin is `needs-configuration` (no source added, listed with its `missing` settings). The connection is a `secret` setting: kept by the
server's config store, never returned by the API (`isSet` only). The database driver comes with the package.

## License

MIT
