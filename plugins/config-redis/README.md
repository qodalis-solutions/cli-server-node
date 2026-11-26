# @qodalis/cli-server-plugin-config-redis

A Redis store for the [config providers](../../README.md#config-providers) of
[Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node): the writable settings of one
provider, several or all of them, kept in Redis and shared by every server using the same Redis.

## Install

```bash
npm install @qodalis/cli-server-plugin-config-redis
```

It uses [ioredis](https://github.com/redis/ioredis) (installed with it).

## Quick Start

Every provider can have its own store. Keep `jobs` in Redis and the rest in the app's settings file:

```typescript
import { createCliServer, JsonFileConfigStore } from '@qodalis/cli-server-node';
import { CliRedisConfigStore } from '@qodalis/cli-server-plugin-config-redis';

const redisStore = new CliRedisConfigStore({ url: process.env.REDIS_URL }); // redis://[:password@]host:6379/0

const server = createCliServer({
    config: {
        store: new JsonFileConfigStore('config/app.json', { section: 'qcli' }), // the default store
        stores: { jobs: redisStore },                                             // per provider id
    },
});
await server.config.ready();
```

Other ways to give a provider this store:

```typescript
builder.setConfigStore(redisStore);                         // the default store: every provider without its own
builder.setConfigStore(redisStore, 'users');                // one provider, by id (wins over the provider's own)
new CliJobsBuilder().setConfigStore(redisStore);            // the jobs plugin's provider (also users, portal, admin)
new CliStoredConfigProvider({ id: 'billing', title: 'Billing', store: redisStore, sections: [/* ... */] });
```

One store may serve several providers: their data never mixes (one key per provider and section).

## Options

| Option | Default | Description |
|---|---|---|
| `url` | | A Redis URL (`redis://`, `rediss://` for TLS); the store creates its client (connecting on the first command) and `close()` ends it |
| `client` | | An ioredis client of your app (or any object with `hgetall` and `eval`); the store never closes it. `client` or `url` is required |
| `keyPrefix` | `qcli:config:` | Prepended to every key |
| `ttlSeconds` | none | Expire a section this many seconds after its last change; without it sections are kept until deleted |
| `maxRetries` | `10` | How often a write without an expected version is retried when another write came first |

## How It Works

- **One hash per provider section**: `qcli:config:<provider>:<section>` with the fields `values` (the settings
  changed from their defaults, as JSON), `version` (grows by one on every write) and `updatedAt` (ISO 8601).
- **Atomic, versioned writes**: a write reads the section, applies the changes (`null` removes a key) and stores them
  with a Lua script (`REDIS_CONFIG_WRITE_SCRIPT`) that first checks the version is still the one read. A change made
  with an expected version (the dashboard, `config set --expected-version`, `PATCH` with `version`) that is stale, or
  that loses the race to another server, is refused with `CliConfigConflictError` (HTTP 409 with the current version);
  one without is retried on the new values, so concurrent writers never lose a change.
- **Source** `database`, **persistent**: the settings survive server restarts (as long as Redis keeps its data).
- **`describe()`**: `{ "kind": "redis", "title": "Redis", "detail": "cache:6379/0, prefix qcli:config", "persistent": true }`
  (host, port, database and key prefix; never the user or password), shown as the provider's `store` by
  `GET /api/v1/qcli/config` and by `config list`:

```text
jobs  Jobs  · Redis (cache:6379/0, prefix qcli:config)
```

Secrets are stored as given: protect the Redis (password, TLS, network) like the rest of the server's data.

## Tests

The store runs the same contract as the in-memory, JSON file and database stores on a fake Redis. Set
`QCLI_TEST_REDIS` (`redis://localhost:6379/15`) to run it against a real Redis too, keys under a temporary prefix
removed afterwards.

## Terminal commands

None of its own: the settings are read and changed with the server's [`config` command](../../README.md#terminal-commands)
(`config list`, `config get`, `config set`, `config reset`).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install config-redis`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into
`<dataDir>/server-plugins` and loads it at the next start ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)).
Its entry (`qodalis.entry`, `dist/plugin.js`) brings Redis as the server's default config store. Its own settings are kept in `<dataDir>/plugin-settings.json`, never in Redis. Load order: `CONFIG_STORE` (20): the providers registered before it (the host's, the users plugin's) move to Redis, those after it start there.

| Setting | Type | Default | | |
|---|---|---|---|---|
| `url` | secret | — | required | redis://[:password@]host:6379/0 (rediss:// for TLS); kept as a secret, never returned |
| `keyPrefix` | string | `qcli:config:` |  | Prepended to every key: <prefix><provider>:<section> |
| `ttlSeconds` | number | `0` |  | A section expires this long after its last change; 0: never |

Every setting needs a restart. Set them on the Config page or with `config set config-redis.settings.<key> <value>`, then
restart. Without a URL it is `needs-configuration` and the settings stay where they were (the plugins' in `<dataDir>/plugin-settings.json`). A plugin waiting for a required setting is `needs-configuration`: it registers nothing, is listed
with that status and its `missing` settings (installed.json, `GET /api/v1/qcli/server/marketplace/installed`, the
installed plugins), and runs once they are saved and the server restarts. Secrets are kept by the config store
(`<dataDir>/plugin-settings.json` while the server keeps its settings in memory), never returned (`isSet` only).
The marketplace reads these settings from `qodalis.config` of the package.json (`npm run sync:plugin-config`).

## Install in code

The same entry and settings: `builder.addPlugin(entry, options)` runs it with the plugins installed at runtime, in
load order. Options of a setting's key are its defaults (origin `code` on the Config page and in `config get`); a
saved setting overrides them at the next start. Read from code only: `client` (an ioredis client shared with the app).

```ts
import { configRedisPluginEntry } from '@qodalis/cli-server-plugin-config-redis';

const cli = createCliServer({
    configure: (builder) => builder.addPlugin(configRedisPluginEntry, { url: process.env.REDIS_URL }),
});
await cli.serverPlugins.ready(); // before listening
```

The builder API above (`mountPlugin`) keeps working; it does not expose the settings.

## License

MIT
