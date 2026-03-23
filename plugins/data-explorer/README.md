# @qodalis/cli-server-plugin-data-explorer

Data explorer plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Provides a REST API for querying and browsing data sources through pluggable provider backends. Handles provider registration, query execution with timeout enforcement, and row-limit truncation.

## Install

```bash
npm install @qodalis/cli-server-plugin-data-explorer
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import {
    DataExplorerBuilder,
    createDataExplorerController,
    DataExplorerExecutor,
} from '@qodalis/cli-server-plugin-data-explorer';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const { app } = createCliServer({});

const deBuilder = new DataExplorerBuilder()
    .addProvider(myProvider, {
        name: 'my-source',
        description: 'My data source',
        language: DataExplorerLanguage.Sql,
        defaultOutputFormat: DataExplorerOutputFormat.Table,
        timeout: 30000,
        maxRows: 1000,
    });

const executor = new DataExplorerExecutor(deBuilder.registry);
const controller = createDataExplorerController(deBuilder.registry, executor);

app.use('/api/v1/qcli/data-explorer', controller);
```

## REST API

All endpoints are mounted at the path you choose (typically `/api/v1/qcli/data-explorer`).

| Method | Endpoint | Description |
|---|---|---|
| GET | `/sources` | List all registered data sources with their language, output format, and query templates |
| GET | `/schema?source=<name>` | Introspect a source's schema (tables, columns, types) |
| POST | `/execute` | Execute a query against a named source |

### Execute Request Body

```json
{
    "source": "my-source",
    "query": "SELECT * FROM users LIMIT 10",
    "parameters": {}
}
```

## Provider Options

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | Required | Unique data source name |
| `description` | `string` | -- | Human-readable description |
| `language` | `DataExplorerLanguage` | Required | Query language (e.g. `sql`, `mongodb`, `redis`, `elasticsearch`) |
| `defaultOutputFormat` | `DataExplorerOutputFormat` | Required | Default output format (`table` or `json`) |
| `timeout` | `number` | `30000` | Query timeout in milliseconds |
| `maxRows` | `number` | -- | Maximum rows to return (excess rows are truncated) |
| `templates` | `array` | `[]` | Predefined query templates |
| `parameters` | `array` | `[]` | Configurable source parameters |

## Available Providers

| Package | Database |
|---|---|
| `@qodalis/cli-server-plugin-data-explorer-sql` | SQLite |
| `@qodalis/cli-server-plugin-data-explorer-postgres` | PostgreSQL |
| `@qodalis/cli-server-plugin-data-explorer-mysql` | MySQL |
| `@qodalis/cli-server-plugin-data-explorer-mssql` | Microsoft SQL Server |
| `@qodalis/cli-server-plugin-data-explorer-mongo` | MongoDB |
| `@qodalis/cli-server-plugin-data-explorer-elasticsearch` | Elasticsearch |
| `@qodalis/cli-server-plugin-data-explorer-redis` | Redis |

## License

MIT
