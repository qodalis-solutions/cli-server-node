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

## License

MIT
