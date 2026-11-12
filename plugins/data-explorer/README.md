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
| GET | `/sources` | The sources the caller may use, with language, output format, templates, `readOnly` and `canExport` |
| GET | `/schema?source=<name>` | A source's schema: allowed tables only, without dropped columns (403 without the source's permissions) |
| POST | `/execute` | Execute a query against a named source (403 without the source's permissions, 429 over its rate limit) |

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
| `requiredPermissions` | `string[]` | -- | Permissions the caller needs besides `data:query`; other callers do not see the source (ignored on an open server) |
| `readOnly` | `boolean` | `true` | Only queries that read are accepted, and SQL providers run them in a read-only transaction. Set `false` for a source that must write |
| `allowedObjects` | `string[]` | all | Glob patterns of the tables, collections, Redis keys or indices the source shows and accepts |
| `maskColumns` | `string[]` | -- | Glob patterns of columns/fields whose values are shown as `***` |
| `dropColumns` | `string[]` | -- | Glob patterns of columns/fields removed from results and the schema |
| `audit` | `boolean` | `true` | Writes a `data_query` entry to the server's audit log for every execute |
| `rateLimit` | `{ maxQueries, windowSeconds }` | -- | Executes allowed per caller and window; more answer 429 |
| `exportPermissions` | `string[]` | -- | Permissions needed to export results (`canExport` in `/sources`; advisory) |

### Read-only sources

Sources are read-only unless they set `readOnly: false`. The server checks each query before the provider runs it:

- SQL: one statement starting with `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `DESCRIBE`, `VALUES` or `TABLE`, without write keywords (comments and strings ignored).
- MongoDB: `show collections` or `db.<collection>.find|findOne|countDocuments|estimatedDocumentCount|distinct|aggregate(...)` without `$out`/`$merge`.
- Redis: read commands only (`GET`, `HGETALL`, `LRANGE`, `KEYS`, `SCAN`, ...).
- Elasticsearch: `GET`/`HEAD`, or `POST` to `_search`, `_count`, `_msearch`, `_mget`, `_field_caps`, `_validate/query`.

The SQL providers also run the query in a read-only transaction (SQLite `query_only`, Postgres `BEGIN READ ONLY`, MySQL `START TRANSACTION READ ONLY`, SQL Server a transaction that is always rolled back).

`allowedObjects` and the read-only check are a convenience filter. Give the source a database account that can only read what staff may see: that account is the real boundary.

```typescript
builder.addDataExplorerProvider(provider, {
    name: 'billing',
    language: DataExplorerLanguage.Sql,
    defaultOutputFormat: DataExplorerOutputFormat.Table,
    requiredPermissions: ['data:billing'],
    allowedObjects: ['public.invoices', 'public.customers'],
    maskColumns: ['email', '*phone*'],
    dropColumns: ['password_hash'],
    rateLimit: { maxQueries: 30, windowSeconds: 60 },
    exportPermissions: ['data:export'],
});
```

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
