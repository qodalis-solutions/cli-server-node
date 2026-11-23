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

With the default prefix `qcli_` (`createPostgresUsersStores(url, { tablePrefix: 'auth_' })` changes it):

| Table | Holds |
|---|---|
| `qcli_users` | Users; names and emails unique ignoring case; groups and `data` as JSONB |
| `qcli_groups` | Groups and their permissions; names unique ignoring case |
| `qcli_credentials` | Password hash and salt per user |
| `qcli_sessions` | Sessions by token hash (SHA-256; raw tokens are never stored) |
| `qcli_api_tokens` | API tokens by hash, with audience and permissions |
| `qcli_audit` | The audit log, newest first by insertion order |
| `qcli_schema_migrations` | The migrations applied (id, name, time) |

Times are epoch milliseconds (`bigint`), as in the users plugin's models.

## Migrations

`init()` applies the migrations the database does not have yet, in order, each in its own transaction, under a
PostgreSQL advisory lock so servers starting together never apply one twice (the counterpart of EF Core's
`__EFMigrationsHistory`). A database migrated by a newer package version is refused with
`the database has migrations this version does not know`, rather than used with a schema this version does not
know. New versions of this package only append migrations; released ones never change.

Your own tables can use the same runner:

```ts
import { runPostgresMigrations } from '@qodalis/cli-server-plugin-users-postgres';

await runPostgresMigrations(pool, 'myapp_schema_migrations', [
    { id: 1, name: 'create orders', up: 'CREATE TABLE orders (id text PRIMARY KEY, total numeric NOT NULL)' },
    { id: 2, name: 'orders.created_at', up: 'ALTER TABLE orders ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()' },
]);
```

## Audit log

Unlike the in-memory store (latest 1000 entries), the PostgreSQL audit store keeps every entry. Bound it with
`pruneAudit(stores.auditStore, before)` on a schedule, e.g. a [jobs plugin](../jobs/README.md) job.

## Tests

The store tests run the same contract against the in-memory and the PostgreSQL stores. The PostgreSQL part runs
when `QCLI_TEST_POSTGRES` holds a connection string to an empty database the tests may wipe; CI starts a
`postgres:17` service for it.
