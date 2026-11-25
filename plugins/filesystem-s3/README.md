# @qodalis/cli-server-plugin-filesystem-s3

Amazon S3 storage provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Implements the `IFileStorageProvider` interface using S3 (or any S3-compatible service such as MinIO) as the storage backend.

## Install

```bash
npm install @qodalis/cli-server-plugin-filesystem-s3
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { FileSystemModule } from '@qodalis/cli-server-plugin-filesystem';
import { S3FileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-s3';

const { app } = createCliServer({
    configure: (builder) => {
        builder.addModule(new FileSystemModule());
        builder.setFileStorageProvider(
            new S3FileStorageProvider({
                bucket: 'my-bucket',
                region: 'us-east-1',
            }),
        );
    },
});
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `bucket` | `string` | Required | S3 bucket name |
| `region` | `string` | `us-east-1` | AWS region |
| `prefix` | `string` | `''` | Key prefix prepended to all virtual paths |
| `endpoint` | `string` | -- | Custom S3-compatible endpoint URL (e.g. MinIO) |
| `credentials` | `object` | -- | Explicit `{ accessKeyId, secretAccessKey }`; omit to use the default AWS credential chain |

## How It Works

- Directories are represented by zero-byte S3 objects with a trailing `/`.
- Listing uses the S3 `Delimiter: '/'` convention to separate files and directories.
- Recursive delete and copy iterate over all objects matching the directory prefix.
- When no explicit credentials are provided, the provider uses the standard AWS credential chain (environment variables, IAM roles, etc.).

## Dependencies

- `@aws-sdk/client-s3`

## Terminal commands

None of its own: the storage is reached through the [filesystem plugin](../filesystem/README.md#terminal-commands)
(`scp` in the web CLI).

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install filesystem-s3`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) sets the filesystem API's storage to an S3 (or S3-compatible) bucket, read-only unless `readOnly` is off.

| Setting | Type | Default | |
|---|---|---|---|
| `bucket` | string | empty | Nothing is served until it is set |
| `region` | string | `us-east-1` |  |
| `prefix` | string | empty | Prepended to every path |
| `endpoint` | string | empty | An S3-compatible service (MinIO) |
| `accessKeyId` | secret | — | Empty: the AWS default credential chain |
| `secretAccessKey` | secret | — |  |
| `readOnly` | boolean | `true` | Writes refused (403) |

The keys are `secret` settings: kept server-side, never returned. Every setting needs a restart. Refused when the
storage is already set.

## License

MIT
