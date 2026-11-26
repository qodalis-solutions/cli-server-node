# @qodalis/cli-server-plugin-data-explorer-redis

Redis data explorer provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Connects to a Redis instance and executes commands from a safe allowlist, returning results as tabular data.

## Install

```bash
npm install @qodalis/cli-server-plugin-data-explorer-redis
```

## Quick Start

```typescript
import {
    DataExplorerBuilder,
    createDataExplorerController,
    DataExplorerExecutor,
} from '@qodalis/cli-server-plugin-data-explorer';
import { RedisDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-redis';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const deBuilder = new DataExplorerBuilder()
    .addProvider(
        new RedisDataExplorerProvider({
            connectionString: 'redis://localhost:6379',
        }),
        {
            name: 'redis',
            description: 'Redis instance',
            language: DataExplorerLanguage.Redis,
            defaultOutputFormat: DataExplorerOutputFormat.Table,
        },
    );

const executor = new DataExplorerExecutor(deBuilder.registry);
app.use('/api/v1/qcli/data-explorer', createDataExplorerController(deBuilder.registry, executor));
```

## Configuration

| Option | Type | Description |
|---|---|---|
| `connectionString` | `string` | Redis connection URI (e.g. `redis://localhost:6379`) |

## Allowed Commands

Only a safe subset of Redis commands is permitted:

| Category | Commands |
|---|---|
| Strings | `GET`, `SET`, `MGET`, `MSET`, `INCR`, `DECR` |
| Hashes | `HGET`, `HSET`, `HGETALL`, `HDEL`, `HKEYS`, `HVALS` |
| Lists | `LPUSH`, `RPUSH`, `LRANGE`, `LLEN` |
| Sets | `SADD`, `SMEMBERS`, `SCARD` |
| Sorted Sets | `ZADD`, `ZRANGE`, `ZRANGEBYSCORE` |
| Keys | `DEL`, `EXISTS`, `EXPIRE`, `TTL`, `PTTL`, `TYPE`, `KEYS`, `SCAN` |
| Server | `INFO`, `DBSIZE`, `PING`, `FLUSHDB` |

## Query Format

Queries use standard Redis command syntax:

```
GET mykey
HGETALL user:1
KEYS user:*
INFO server
```

Quoted strings are supported for values containing spaces.

## Schema Introspection

Schema discovery scans keys (up to 10 iterations of `SCAN`) and groups them by Redis data type (`string`, `hash`, `list`, `set`, `zset`), reporting each type as a virtual table with appropriate columns.

## Dependencies

- `ioredis`

## Terminal commands

None of its own: the provider is queried through the [data explorer plugin](../data-explorer/README.md#terminal-commands)
(`data-explorer` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install data-explorer-redis`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) adds one Redis source to the data explorer from its settings.

| Setting | Type | Default | |
|---|---|---|---|
| `name` | string | `redis` | The source name in the data explorer |
| `description` | string | the engine name |  |
| `connectionString` | secret | — | `redis://:password@host:6379/0` |
| `readOnly` | boolean | `true` | Queries may only read |
| `timeoutMs` | number | `30000` | 1000-600000 |
| `maxRows` | number | `1000` | 1-100000 |

Every setting needs a restart. Set them with `config set data-explorer-redis.settings.<key> <value>` or the Config page, then restart: until
the connection is set the plugin is `needs-configuration` (no source added, listed with its `missing` settings). The connection is a `secret` setting: kept by the
server's config store, never returned by the API (`isSet` only). The database driver comes with the package.

## License

MIT
