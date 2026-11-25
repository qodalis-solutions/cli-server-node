# @qodalis/cli-server-plugin-data-explorer-postgres

PostgreSQL data explorer provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Connects to a PostgreSQL database and executes SQL queries with schema introspection support.

## Install

```bash
npm install @qodalis/cli-server-plugin-data-explorer-postgres
```

## Quick Start

```typescript
import {
    DataExplorerBuilder,
    createDataExplorerController,
    DataExplorerExecutor,
} from '@qodalis/cli-server-plugin-data-explorer';
import { PostgresDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-postgres';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const deBuilder = new DataExplorerBuilder()
    .addProvider(
        new PostgresDataExplorerProvider({
            connectionString: 'postgresql://user:password@localhost:5432/mydb',
        }),
        {
            name: 'postgres',
            description: 'PostgreSQL database',
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
| `connectionString` | `string` | PostgreSQL connection URI |

## Features

- Execute any SQL query and receive tabular results.
- Schema introspection lists all tables and views in the `public` schema with column names, data types, nullability, and primary key detection via table constraints.

## Dependencies

- `pg`

## Terminal commands

None of its own: the provider is queried through the [data explorer plugin](../data-explorer/README.md#terminal-commands)
(`data-explorer` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install data-explorer-postgres`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) adds one PostgreSQL source to the data explorer from its settings.

| Setting | Type | Default | |
|---|---|---|---|
| `name` | string | `postgres` | The source name in the data explorer |
| `description` | string | the engine name |  |
| `connectionString` | secret | — | `postgres://user:password@host:5432/database` |
| `readOnly` | boolean | `true` | Queries may only read |
| `timeoutMs` | number | `30000` | 1000-600000 |
| `maxRows` | number | `1000` | 1-100000 |

Every setting needs a restart. Set them with `config set data-explorer-postgres.settings.<key> <value>` or the Config page, then restart: until
the connection is set, no source is added (a warning is logged). The connection is a `secret` setting: kept by the
server's config store, never returned by the API (`isSet` only). The database driver comes with the package.

## License

MIT
