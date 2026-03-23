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

## License

MIT
