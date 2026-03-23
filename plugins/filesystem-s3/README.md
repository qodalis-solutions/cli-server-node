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

## License

MIT
