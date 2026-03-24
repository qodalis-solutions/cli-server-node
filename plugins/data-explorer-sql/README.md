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

## License

MIT
