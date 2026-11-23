# @qodalis/cli-server-plugin-migrations

Database migrations for the Qodalis CLI server: versioned schema changes of PostgreSQL, MySQL/MariaDB, SQL Server
and SQLite databases, applied under a lock, recorded with who ran them, when and how long they took, and shown, run
and rolled back from the admin dashboard, the web terminal (`migrations`) and the API.

```bash
npm install @qodalis/cli-server-plugin-migrations
```

## Use

```ts
import { Pool } from 'pg';
import { createCliServer } from '@qodalis/cli-server-node';
import { CliMigrationsBuilder, postgresConnection } from '@qodalis/cli-server-plugin-migrations';

const { app, mountPlugin } = createCliServer();
const migrations = new CliMigrationsBuilder()
    .addDatabase('main', { connection: postgresConnection(new Pool({ connectionString: process.env.DATABASE_URL })), applyOnStartup: true })
    .addSqlFolder('main', './migrations')
    .build();

await migrations.applyOnStartup(); // pending migrations before the server listens; a failure stops startup
mountPlugin(migrations);
app.listen(8047);
```

Connections: `postgresConnection(pool)` (`pg`), `mysqlConnection(pool)` (`mysql2/promise`, created with
`multipleStatements: true`), `mssqlConnection(pool)` (`mssql`), `sqliteConnection(db)` (`better-sqlite3`). The plugin
needs none of the drivers itself.

## Migrations

- **A folder of SQL files**: `0001_create_users.up.sql`, with an optional `0001_create_users.down.sql` to roll it back.
  A file starting with `-- qcli:no-transaction` runs outside a transaction (e.g. `CREATE INDEX CONCURRENTLY`).
- **Code**: `addMigrations('main', 'billing', [{ id: '1', name: 'create invoices', up: 'CREATE TABLE …', down: 'DROP TABLE …' }])`.
  `up`/`down` can be SQL, SQL per dialect (`{ postgres: '…', sqlite: '…' }`) or a function given the session.
  This is how plugins ship their schema.

A database can have several sources; they apply in the order they were added. Released migrations are never edited
or reordered: add a new one instead. Each migration runs in its own transaction together with its history row
(MySQL commits DDL statements on its own, so a failing MySQL migration may leave a table behind).

## Status, runs and safety

- `QcliMigrations` holds the applied migrations (source, id, name, checksum, applied at/by, duration) and
  `QcliMigrationRuns` every run (direction, target, trigger, who, start/end, status, error, what it applied). The
  prefix follows the plugin table names (`tablePrefix`, `schema`, per-table `tables` overrides).
- A migration is `applied`, `pending`, `changed` (its SQL differs from what was applied), `missing` (applied, no longer
  in its source) or `failed` (the last run stopped at it). Runs are refused while one is `changed` or `missing`, unless
  `force`.
- One run at a time: a lock per database (`pg_advisory_lock`, `GET_LOCK`, `sp_getapplock`) across processes, so two
  servers starting together apply once. The API and terminal answer busy (409); `applyOnStartup` waits.
- Every run publishes `migrations:run` (audience `migrations:read`) and, with `setAuditStore(store)`, writes
  `migrations.up` / `migrations.down` to the audit log.

## API and terminal

| | |
|---|---|
| `GET /api/v1/qcli/migrations` | databases: applied, pending, problems, last run |
| `GET /api/v1/qcli/migrations/{db}` | its migrations and their status |
| `GET /api/v1/qcli/migrations/{db}/runs?page=&size=` | run history, newest first |
| `GET /api/v1/qcli/migrations/{db}/sql?direction=up\|down&to=` | the SQL a run would execute (dry run) |
| `POST /api/v1/qcli/migrations/{db}/up` `{ to?, force? }` | apply pending migrations |
| `POST /api/v1/qcli/migrations/{db}/down` `{ to }` | roll back to `to` (kept; `base` for everything) |

Permissions on a protected server: `migrations:read` for reading, `migrations:run` for up and down. Terminal:
`migrations`, `migrations status <db>`, `migrations up <db> [--to <id>] [--dry-run] [--force]`,
`migrations down <db> --to <id> [--dry-run]`.

With the server's MCP endpoint on, AI clients get `migrations_status`, `migrations_runs`, `migrations_sql`
(`migrations:read`), `migrations_up` and `migrations_down` (`migrations:run`); their runs are recorded with trigger `mcp`.

## Helpers for store authors

`tableExists`, `columnExists`, `renameTable`, `renameColumn` and `adoptLegacyTable(db, legacy, table, columns)` (renames a
previous release's table and its columns to the new names, keeping the data) work on every dialect.
