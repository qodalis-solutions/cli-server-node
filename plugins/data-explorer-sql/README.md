# @qodalis/cli-server-plugin-data-explorer-sql

SQLite data explorer provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Connects to a SQLite database file and executes SQL queries with schema introspection support.

## Install

```bash
npm install @qodalis/cli-server-plugin-data-explorer-sql
```

## Quick Start

```typescript
import {
    DataExplorerBuilder,
    createDataExplorerController,
    DataExplorerExecutor,
} from '@qodalis/cli-server-plugin-data-explorer';
import { SqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-sql';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const deBuilder = new DataExplorerBuilder()
    .addProvider(
        new SqlDataExplorerProvider({
            type: 'sqlite',
            filename: './data/mydb.sqlite',
        }),
        {
            name: 'sqlite',
            description: 'SQLite database',
            language: DataExplorerLanguage.Sql,
            defaultOutputFormat: DataExplorerOutputFormat.Table,
        },
    );

const executor = new DataExplorerExecutor(deBuilder.registry);
app.use('/api/v1/qcli/data-explorer', createDataExplorerController(deBuilder.registry, executor));
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `type` | `'sqlite' \| 'postgres' \| 'mysql'` | Required | Database engine type |
| `filename` | `string` | `':memory:'` | SQLite database file path |
| `connectionString` | `string` | -- | Connection string (for postgres/mysql; not currently used by the built-in implementation) |

## Features

- Execute any SQL query (both read and write statements).
- Read queries return tabular column/row results.
- Write queries return `changes` and `lastInsertRowid`.
- Schema introspection lists all tables and views (excluding SQLite internals) with column names, types, nullability, and primary key detection via `PRAGMA table_info`.

## Dependencies

- `better-sqlite3`

## Terminal commands

None of its own: the provider is queried through the [data explorer plugin](../data-explorer/README.md#terminal-commands)
(`data-explorer` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install data-explorer-sql`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) adds one SQL source (SQLite, PostgreSQL or MySQL) to the data explorer from its settings.

| Setting | Type | Default | |
|---|---|---|---|
| `name` | string | `sql` | The source name in the data explorer |
| `description` | string | the engine name |  |
| `type` | enum | `sqlite` | `sqlite`, `postgres` or `mysql` |
| `filename` | string | `data.db` | SQLite; relative to `<dataDir>/plugin-data/data-explorer-sql` |
| `connectionString` | secret | — | PostgreSQL and MySQL |
| `readOnly` | boolean | `true` | Queries may only read |
| `timeoutMs` | number | `30000` | 1000-600000 |
| `maxRows` | number | `1000` | 1-100000 |

Every setting needs a restart. With `sqlite` (the default) the source is added at once on a file of the plugin's data
directory; PostgreSQL and MySQL need the connection string (a `secret` setting, never returned).

## License

MIT
