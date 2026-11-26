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

The schema is versioned with `@qodalis/cli-server-plugin-databases` (source `qcli-filesystem`, history in
`QcliMigrations` of the same database). Opening a database of an earlier release renames its `files` table and
columns to these names, keeping the data. Options: `tablePrefix` (default `Qcli`), `tables: { Files: 'MyFiles' }`,
and `legacyTableNames: true` to keep `files` and its snake_case columns. To see and run the table's migrations from
the dashboard, register the store's database with the databases plugin:
`builder.addDatabase('files', { connection: provider.connection }).addSource('files', provider.migrationSource)`.

## Dependencies

- `better-sqlite3`
- `@qodalis/cli-server-plugin-databases`

## Terminal commands

None of its own: the storage is reached through the [filesystem plugin](../filesystem/README.md#terminal-commands)
(`scp` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install filesystem-sqlite`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into
`<dataDir>/server-plugins` and loads it at the next start ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)).
Its entry (`qodalis.entry`, `dist/plugin.js`) brings the filesystem API over a file tree in a SQLite file (default `<dataDir>/plugin-data/filesystem-sqlite/files.db`). Refused when the filesystem storage is already set. Load order: `DEFAULT` (50).

| Setting | Type | Default | | |
|---|---|---|---|---|
| `dbPath` | string | `files.db` | required | The SQLite file (relative paths from the plugin's data directory; :memory: for none) |
| `tablePrefix` | string | `Qcli` |  | Prepended to the table name (default Qcli) |
| `readOnly` | boolean | `false` |  | Uploads, new folders and deletes are refused |

Every setting needs a restart. Set them on the Config page or with `config set filesystem-sqlite.settings.<key> <value>`, then
restart. Nothing is required. A plugin waiting for a required setting is `needs-configuration`: it registers nothing, is listed
with that status and its `missing` settings (installed.json, `GET /api/v1/qcli/server/marketplace/installed`, the
installed plugins), and runs once they are saved and the server restarts. Secrets are kept by the config store
(`<dataDir>/plugin-settings.json` while the server keeps its settings in memory), never returned (`isSet` only).
The marketplace reads these settings from `qodalis.config` of the package.json (`npm run sync:plugin-config`).

## Install in code

The same entry and settings: `builder.addPlugin(entry, options)` runs it with the plugins installed at runtime, in
load order. Options of a setting's key are its defaults (origin `code` on the Config page and in `config get`); a
saved setting overrides them at the next start. Read from code only: nothing.

```ts
import { filesystemSqlitePluginEntry } from '@qodalis/cli-server-plugin-filesystem-sqlite';

const cli = createCliServer({
    configure: (builder) => builder.addPlugin(filesystemSqlitePluginEntry, { dbPath: '/var/lib/app/files.db' }),
});
await cli.serverPlugins.ready(); // before listening
```

The builder API above (`mountPlugin`) keeps working; it does not expose the settings.

## License

MIT
