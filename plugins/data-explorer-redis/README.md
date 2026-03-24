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

## License

MIT
