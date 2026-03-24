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

## License

MIT
