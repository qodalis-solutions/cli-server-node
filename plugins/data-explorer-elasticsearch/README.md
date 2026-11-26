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

## Terminal commands

None of its own: the provider is queried through the [data explorer plugin](../data-explorer/README.md#terminal-commands)
(`data-explorer` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install data-explorer-elasticsearch`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) adds one Elasticsearch source to the data explorer from its settings.

| Setting | Type | Default | |
|---|---|---|---|
| `name` | string | `elasticsearch` | The source name in the data explorer |
| `description` | string | the engine name |  |
| `node` | secret | — | `https://user:password@host:9200` (a secret: it may hold credentials) |
| `readOnly` | boolean | `true` | Queries may only read |
| `timeoutMs` | number | `30000` | 1000-600000 |
| `maxRows` | number | `1000` | 1-100000 |

Every setting needs a restart. Set them with `config set data-explorer-elasticsearch.settings.<key> <value>` or the Config page, then restart: until
the connection is set the plugin is `needs-configuration` (no source added, listed with its `missing` settings). The connection is a `secret` setting: kept by the
server's config store, never returned by the API (`isSet` only). The database driver comes with the package.

## License

MIT
