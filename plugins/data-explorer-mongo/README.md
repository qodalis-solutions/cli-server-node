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

## License

MIT
