# @qodalis/cli-server-plugin-databases

The Qodalis CLI server's relational databases (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite): their size, load and
largest tables, and their migrations, versioned schema changes applied under a lock, recorded with who ran them, when
and how long they took, and shown, run and rolled back from the admin dashboard, the web terminal (`databases`), MCP
and the API.

```bash
npm install @qodalis/cli-server-plugin-databases
```

## Use

```ts
import { Pool } from 'pg';
import { createCliServer } from '@qodalis/cli-server-node';
import { CliDatabasesBuilder, postgresConnection } from '@qodalis/cli-server-plugin-databases';

const { app, mountPlugin } = createCliServer();
const databases = new CliDatabasesBuilder()
    .addDatabase('main', { connection: postgresConnection(new Pool({ connectionString: process.env.DATABASE_URL })), applyOnStartup: true })
    .addSqlFolder('main', './migrations')
    .build();

await databases.applyOnStartup(); // pending migrations before the server listens; a failure stops startup
mountPlugin(databases);
app.listen(8047);
```

Connections: `postgresConnection(pool)` (`pg`), `mysqlConnection(pool)` (`mysql2/promise`, created with
`multipleStatements: true`), `mssqlConnection(pool)` (`mssql`), `sqliteConnection(db)` (`better-sqlite3`). The plugin
needs none of the drivers itself.

## Stats

`GET /api/v1/qcli/databases/{db}/stats` (terminal `databases stats <db>`, MCP `databases_stats`):

- `server`: version, start time and uptime
- `size`: bytes, with data, indexes and (SQL Server) log
- `connections`: active, open and the server's maximum
- `counters`: queries, transactions, commits, rollbacks, rows read and written, cumulative since the server started
  (`countersScope`: `database`, or `server` on MySQL and for SQL Server's batches); the dashboard turns two samples
  into rates
- `cacheHitRatio` (0..1) and `tables`: the 10 largest tables with their rows and bytes

Each metric is collected on its own: one the database refuses (SQL Server without `VIEW SERVER STATE`, a managed
PostgreSQL hiding `pg_stat_activity`) is listed in `unavailable` and the rest still come. SQLite has no server, so only
its version, size and tables. The list (`GET /api/v1/qcli/databases`) carries each database's `sizeBytes`.

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
- Every run publishes `databases:migration-run` (audience `databases:read`) and, with `setAuditStore(store)`, writes
  `migrations.up` / `migrations.down` to the audit log.

## API and terminal

| | |
|---|---|
| `GET /api/v1/qcli/databases` | databases: size, applied, pending, problems, last run |
| `GET /api/v1/qcli/databases/{db}` | one of them |
| `GET /api/v1/qcli/databases/{db}/stats` | its stats (above) |
| `GET /api/v1/qcli/databases/{db}/migrations` | its migrations and their status |
| `GET /api/v1/qcli/databases/{db}/migrations/runs?page=&size=` | run history, newest first |
| `GET /api/v1/qcli/databases/{db}/migrations/sql?direction=up\|down&to=` | the SQL a run would execute (dry run) |
| `POST /api/v1/qcli/databases/{db}/migrations/up` `{ to?, force? }` | apply pending migrations |
| `POST /api/v1/qcli/databases/{db}/migrations/down` `{ to }` | roll back to `to` (kept; `base` for everything) |

Permissions on a protected server: `databases:read` for reading, `databases:migrate` for up and down. Terminal
(`databases`, alias `db`): `databases list`, `databases stats <db>`, `databases migrations <db>`,
`databases up <db> [--to <id>] [--dry-run] [--force]`, `databases down <db> --to <id> [--dry-run]`.

With the server's MCP endpoint on, AI clients get `databases_list`, `databases_stats`, `migrations_status`,
`migrations_runs`, `migrations_sql`
(`databases:read`), `migrations_up` and `migrations_down` (`databases:migrate`); their runs are recorded with trigger `mcp`.

## Dashboard page

The admin dashboard shows a Databases page (group Data, `databases:read`): the databases with their size, and for each
an overview (size, connections, transactions and queries per second over the last minutes, cache hit ratio, largest
tables), its migrations by status and the runs; with `databases:migrate`, Apply pending / Migrate to here / Roll back
to here with the SQL each run executes. It is `@qodalis/cli-dashboard-module-databases`, copied into the package at build (`dashboard/`) and served
at `/qcli/databases`; the plugin registers it as a dashboard extension when mounted. `setDashboardDir(dir)` serves
another build, `setDashboardDir(false)` leaves the page out.

## Helpers for store authors

`tableExists`, `columnExists`, `renameTable`, `renameColumn` and `adoptLegacyTable(db, legacy, table, columns)` (renames a
previous release's table and its columns to the new names, keeping the data) work on every dialect.
