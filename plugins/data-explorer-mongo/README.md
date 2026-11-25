# @qodalis/cli-server-plugin-data-explorer-mongo

MongoDB data explorer provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Connects to a MongoDB database and executes queries using familiar `db.collection.operation()` syntax.

## Install

```bash
npm install @qodalis/cli-server-plugin-data-explorer-mongo
```

## Quick Start

```typescript
import {
    DataExplorerBuilder,
    createDataExplorerController,
    DataExplorerExecutor,
} from '@qodalis/cli-server-plugin-data-explorer';
import { MongoDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-mongo';
import { DataExplorerLanguage, DataExplorerOutputFormat } from '@qodalis/cli-server-abstractions';

const deBuilder = new DataExplorerBuilder()
    .addProvider(
        new MongoDataExplorerProvider({
            connectionString: 'mongodb://localhost:27017',
            database: 'mydb',
        }),
        {
            name: 'mongo',
            description: 'MongoDB database',
            language: DataExplorerLanguage.MongoDb,
            defaultOutputFormat: DataExplorerOutputFormat.Json,
        },
    );

const executor = new DataExplorerExecutor(deBuilder.registry);
app.use('/api/v1/qcli/data-explorer', createDataExplorerController(deBuilder.registry, executor));
```

## Configuration

| Option | Type | Description |
|---|---|---|
| `connectionString` | `string` | MongoDB connection URI |
| `database` | `string` | Database name to operate on |

## Query Syntax

### Collection Operations

Use `db.collection.operation(args)` syntax:

| Operation | Example |
|---|---|
| `find` | `db.users.find({active: true})` |
| `findOne` | `db.users.findOne({_id: "abc"})` |
| `aggregate` | `db.orders.aggregate([{$group: {_id: "$status", count: {$sum: 1}}}])` |
| `insertOne` | `db.users.insertOne({name: "Alice"})` |
| `insertMany` | `db.users.insertMany([{name: "Bob"}, {name: "Carol"}])` |
| `updateOne` | `db.users.updateOne({name: "Alice"}, {$set: {active: true}})` |
| `updateMany` | `db.users.updateMany({}, {$set: {active: true}})` |
| `deleteOne` | `db.users.deleteOne({name: "Alice"})` |
| `deleteMany` | `db.users.deleteMany({active: false})` |
| `countDocuments` | `db.users.countDocuments({active: true})` |
| `distinct` | `db.users.distinct("status")` |

### Convenience Commands

| Command | Description |
|---|---|
| `show collections` | List all collections in the database |
| `show dbs` | List all databases |

## Schema Introspection

Schema discovery samples one document from each collection to infer field names and types.

## Dependencies

- `mongodb`

## Terminal commands

None of its own: the provider is queried through the [data explorer plugin](../data-explorer/README.md#terminal-commands)
(`data-explorer` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install data-explorer-mongo`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) adds one MongoDB source to the data explorer from its settings.

| Setting | Type | Default | |
|---|---|---|---|
| `name` | string | `mongo` | The source name in the data explorer |
| `description` | string | the engine name |  |
| `connectionString` | secret | — | `mongodb://user:password@host:27017` |
| `database` | string | empty | The database queried (required) |
| `readOnly` | boolean | `true` | Queries may only read |
| `timeoutMs` | number | `30000` | 1000-600000 |
| `maxRows` | number | `1000` | 1-100000 |

Every setting needs a restart. Set them with `config set data-explorer-mongo.settings.<key> <value>` or the Config page, then restart: until
the connection is set, no source is added (a warning is logged). The connection is a `secret` setting: kept by the
server's config store, never returned by the API (`isSet` only). The database driver comes with the package.

## License

MIT
