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

Permissions on a protected server: `databases:read` for reading, `databases:migrate` for up and down. Terminal:
see [Terminal commands](#terminal-commands).

With the server's MCP endpoint on, AI clients get `databases_list`, `databases_stats`, `migrations_status`,
`migrations_runs`, `migrations_sql`
(`databases:read`), `migrations_up` and `migrations_down` (`databases:migrate`); their runs are recorded with trigger `mcp`.

## Terminal commands

`databases` (alias `db`), registered by `mountPlugin`. The database name may be left out when there is only one.

| Command | Permission | Does |
|---|---|---|
| `databases`, `databases list` | `databases:read` | Databases: dialect, size, applied, pending, problems |
| `databases stats <db>` | `databases:read` | Server version, uptime, size, connections, load counters, cache hits, largest tables |
| `databases migrations <db>` | `databases:read` | Every migration and its status |
| `databases runs <db> [-n 20] [--json]` | `databases:read` | Run history, newest first (1-100): start, direction, status, migrations run, trigger and who ran it, target, error (`GET /{db}/migrations/runs`) |
| `databases up <db> [--to <id>] [--dry-run] [--force]` | `databases:migrate` | Applies the pending migrations (`--dry-run` prints the SQL, `Nothing to run.` when none) |
| `databases down <db> --to <id\|base> [--dry-run]` | `databases:migrate` | Rolls back what came after `--to` |

```text
$ databases runs main -n 3
main (sqlite): 3 of 5 run(s)
Started             Dir  Status    Count Trigger
2026-11-25 10:02:00 down succeeded     1 terminal (root)  to 0002
2026-11-25 10:01:00 up   failed        0 api  no such table: Notes
2026-11-25 10:00:00 up   succeeded     2 startup
```

## Dashboard page

The admin dashboard shows a Databases page (group Data, `databases:read`): the databases with their size, and for each
an overview (size, connections, transactions and queries per second over the last minutes, cache hit ratio, largest
tables), its migrations by status and the runs; with `databases:migrate`, Apply pending / Migrate to here / Roll back
to here with the SQL each run executes. It is `@qodalis/cli-dashboard-module-databases`, copied into the package at build (`dashboard/`) and served
at `/qcli/databases`; the plugin registers it as a dashboard extension when mounted, with cards on the dashboard's Overview (`widgets: ["overview"]`). `setDashboardDir(dir)` serves
another build, `setDashboardDir(false)` leaves the page out.

## Config store

`CliDatabaseConfigStore` keeps the server's writable [config settings](../../README.md#config-providers) in a
table of one of these databases (`QcliConfig`: `Provider`, `Section`, `Version`, `Data` as JSON, `UpdatedAt`; one row
per section). A change runs in a transaction with the row locked, so servers sharing the database never lose one, and
a stale version is refused. The table is created by the migration source `qcli-config` when the store is created.

```ts
import { CliDatabaseConfigStore, postgresConnection } from '@qodalis/cli-server-plugin-databases';

const configStore = new CliDatabaseConfigStore({ connection: postgresConnection(pool), tablePrefix: 'Qcli' });
const server = createCliServer({ config: { store: configStore } });
await server.config.ready();   // stored settings applied
// Show its migration with the others
new CliDatabasesBuilder().addDatabase('main', { connection: configStore.connection }).addSource('main', configStore.migrationSource);
```

Options: `connection`, `tablePrefix`, `schema`, `tables: { Config }`, `database` (its name in the description, when
the connection does not expose it).

`describe()` (the `store` of `GET /api/v1/qcli/config`, the dashboard's Config page and `config list`) names the
dialect, the database and the table: `{ "kind": "database", "title": "Database", "detail": "PostgreSQL database qcli,
table QcliConfig", "persistent": true }`. The name comes from the driver (`pg`'s `database` or the last segment of its
`connectionString`, `mysql2`'s and `mssql`'s `database`, a SQLite file's name; `connection.database`,
`cliDatabaseName(value)`), never the user, password, host or a connection string: a name that looks like one is left out.

## Helpers for store authors

`tableExists`, `columnExists`, `renameTable`, `renameColumn` and `adoptLegacyTable(db, legacy, table, columns)` (renames a
previous release's table and its columns to the new names, keeping the data) work on every dialect.
