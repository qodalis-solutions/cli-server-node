# @qodalis/cli-server-plugin-data-explorer-elasticsearch

Elasticsearch data explorer provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Connects to an Elasticsearch cluster and executes queries using the REST API format (`VERB /path` with optional JSON body).

## Install

```bash
npm install @qodalis/cli-server-plugin-data-explorer-elasticsearch
```

## Quick Start

```typescript
import {
    DataExplorerBuilder,
    createDataExplorerController,
    DataExplorerExecutor,
} from '@qodalis/cli-server-plugin-data-explorer';
import { ElasticsearchDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-elasticsearch';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const deBuilder = new DataExplorerBuilder()
    .addProvider(
        new ElasticsearchDataExplorerProvider({
            node: 'http://localhost:9200',
        }),
        {
            name: 'elasticsearch',
            description: 'Elasticsearch cluster',
            language: DataExplorerLanguage.Elasticsearch,
            defaultOutputFormat: DataExplorerOutputFormat.Table,
        },
    );

const executor = new DataExplorerExecutor(deBuilder.registry);
app.use('/api/v1/qcli/data-explorer', createDataExplorerController(deBuilder.registry, executor));
```

## Configuration

| Option | Type | Description |
|---|---|---|
| `node` | `string` | Elasticsearch node URL (e.g. `http://localhost:9200`) |

## Query Format

Queries use the Elasticsearch REST API syntax. The first line specifies the HTTP method and path; subsequent lines provide an optional JSON body.

```
GET /my-index/_search
{"query": {"match_all": {}}, "size": 10}
```

Bare paths without a verb default to `GET`:

```
_cat/indices
```

## Supported Features

- **`_search` endpoints**: Results are flattened from `hits.hits[]`, extracting `_id` and `_source` fields as columns.
- **`_cat` endpoints**: Automatically request JSON format; results are returned as tabular data.
- **Schema introspection**: Lists all indices (excluding system indices starting with `.`) and their field mappings, including nested properties.
- **Allowed HTTP methods**: `GET`, `POST`, `PUT`, `DELETE`, `HEAD`.

## Dependencies

- `@elastic/elasticsearch`

## License

MIT
