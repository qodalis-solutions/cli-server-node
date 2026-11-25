# @qodalis/cli-server-plugin-users-postgres

PostgreSQL stores for [`@qodalis/cli-server-plugin-users`](../users/README.md): users, groups, passwords, sessions,
API tokens and the audit log are kept in PostgreSQL instead of memory, so accounts, sign-ins and tokens survive
restarts and deploys, and several server instances can share them.

```bash
npm install @qodalis/cli-server-plugin-users-postgres
```

```ts
import { createCliServer } from '@qodalis/cli-server-node';
import { CliUsersBuilder } from '@qodalis/cli-server-plugin-users';
import { createPostgresUsersStores } from '@qodalis/cli-server-plugin-users-postgres';

const cli = createCliServer();
const stores = createPostgresUsersStores(process.env.DATABASE_URL!); // or PoolConfig, or your own Pool
await stores.init(); // applies the schema migrations

const users = new CliUsersBuilder()
    .setUserStore(stores.userStore)
    .setGroupStore(stores.groupStore)
    .setCredentialStore(stores.credentialStore)
    .setSessionStore(stores.sessionStore)
    .setApiTokenStore(stores.apiTokenStore)
    .setAuditStore(stores.auditStore)
    .build(cli.eventBus);
cli.mountPlugin(users);
```

The users plugin seeds the built-in groups and the `root` user only into empty stores, so a restart keeps the
existing accounts. `stores.close()` ends the pool when the stores created it (not a `Pool` you passed in).

## Tables

Named `Qcli` + PascalCase with PascalCase columns, like every plugin's tables (`tablePrefix` changes the prefix,
`tables: { Users: 'AppUsers' }` names one table, `schema` puts them in another schema):

| Table | Holds |
|---|---|
| `QcliUsers` | Users; names and emails unique ignoring case; groups and `Data` as JSONB |
| `QcliGroups` | Groups and their permissions; names unique ignoring case |
| `QcliCredentials` | Password hash and salt per user |
| `QcliSessions` | Sessions by token hash (SHA-256; raw tokens are never stored) |
| `QcliApiTokens` | API tokens by hash, with audience and permissions |
| `QcliAuditEntries` | The audit log, newest first by insertion order |

Times are epoch milliseconds (`bigint`), as in the users plugin's models.

## Migrations

The schema is the migration source `qcli-users` of the [databases plugin](../databases/README.md): `init()` applies
what the database does not have yet, under the plugin's lock, recording it in `QcliMigrations` /
`QcliMigrationRuns`. A database with tables of the first preview (`qcli_users`, ...) is adopted by the first
migration: tables, columns and indexes are renamed and the data kept.

To see and run the users schema from the dashboard and the terminal, register its database with the migrations
plugin:

```ts
const migrations = new CliDatabasesBuilder()
    .addDatabase('users', { connection: stores.connection })
    .addSource('users', stores.migrationSource)
    .build();
cli.mountPlugin(migrations);
```

## Audit log

Unlike the in-memory store (latest 1000 entries), the PostgreSQL audit store keeps every entry. Bound it with
`pruneAudit(stores.auditStore, before)` on a schedule, e.g. a [jobs plugin](../jobs/README.md) job.

## Tests

The store tests run the same contract against the in-memory and the PostgreSQL stores. The PostgreSQL part runs
when `QCLI_TEST_POSTGRES` holds a connection string to an empty database the tests may wipe; CI starts a
`postgres:17` service for it.

## Terminal commands

None of its own: it stores the [users plugin](../users/README.md#terminal-commands)'s data, managed with that plugin's
commands (`adduser`, `token`, `audit`, ...). Its migrations show in `databases runs` when the
[databases plugin](../databases/README.md#terminal-commands) runs them.

## Install from the dashboard

Not installable at runtime: its package declares `"autoInstall": false` (the users plugin's stores in PostgreSQL, passed to `CliUsersBuilder` with the host's pool), so the marketplace and the
dashboard list it with "needs setup in code" and `admin plugins install users-postgres` refuses it. Set it up in code as shown
above.
