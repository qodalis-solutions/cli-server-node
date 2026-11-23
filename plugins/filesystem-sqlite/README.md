# @qodalis/cli-server-plugin-filesystem-sqlite

SQLite-backed storage provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Implements the `IFileStorageProvider` interface using a SQLite database for persistent virtual filesystem storage.

## Install

```bash
npm install @qodalis/cli-server-plugin-filesystem-sqlite
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { FileSystemModule } from '@qodalis/cli-server-plugin-filesystem';
import { SqliteFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-sqlite';

const { app } = createCliServer({
    configure: (builder) => {
        builder.addModule(new FileSystemModule());
        builder.setFileStorageProvider(
            new SqliteFileStorageProvider({
                dbPath: './data/filesystem.db',
            }),
        );
    },
});
```

## Configuration

| Option | Type | Description |
|---|---|---|
| `dbPath` | `string` | Path to the SQLite database file, or `':memory:'` for in-memory operation |

The parent directory is created automatically if it does not exist. The database uses WAL journaling mode for concurrent read performance.

## Schema

The provider keeps the files in one table, `QcliFiles` (plugin tables are `Qcli` + PascalCase), indexed on
`ParentPath` (`IX_QcliFiles_ParentPath`):

| Column | Type | Description |
|---|---|---|
| `Id` | `INTEGER` | Auto-incrementing primary key |
| `Path` | `TEXT` | Unique virtual path |
| `Name` | `TEXT` | Entry name (basename) |
| `Type` | `TEXT` | `file` or `directory` |
| `Content` | `TEXT` | File content (null for directories) |
| `Size` | `INTEGER` | Size in bytes |
| `Permissions` | `TEXT` | Unix-style permission string |
| `CreatedAt` | `TEXT` | ISO 8601 creation timestamp |
| `ModifiedAt` | `TEXT` | ISO 8601 modification timestamp |
| `ParentPath` | `TEXT` | Path of the parent directory |

The schema is versioned with `@qodalis/cli-server-plugin-migrations` (source `qcli-filesystem`, history in
`QcliMigrations` of the same database). Opening a database of an earlier release renames its `files` table and
columns to these names, keeping the data. Options: `tablePrefix` (default `Qcli`), `tables: { Files: 'MyFiles' }`,
and `legacyTableNames: true` to keep `files` and its snake_case columns. To see and run the table's migrations from
the dashboard, register the store's database with the migrations plugin:
`builder.addDatabase('files', { connection: provider.connection }).addSource('files', provider.migrationSource)`.

## Dependencies

- `better-sqlite3`
- `@qodalis/cli-server-plugin-migrations`

## License

MIT
