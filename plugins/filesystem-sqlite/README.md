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

The provider creates and manages a single `files` table:

| Column | Type | Description |
|---|---|---|
| `id` | `INTEGER` | Auto-incrementing primary key |
| `path` | `TEXT` | Unique virtual path |
| `name` | `TEXT` | Entry name (basename) |
| `type` | `TEXT` | `file` or `directory` |
| `content` | `TEXT` | File content (null for directories) |
| `size` | `INTEGER` | Size in bytes |
| `permissions` | `TEXT` | Unix-style permission string |
| `created_at` | `TEXT` | ISO 8601 creation timestamp |
| `modified_at` | `TEXT` | ISO 8601 modification timestamp |
| `parent_path` | `TEXT` | Path of the parent directory |

## Dependencies

- `better-sqlite3`

## License

MIT
