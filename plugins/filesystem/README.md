# @qodalis/cli-server-plugin-filesystem

Pluggable file storage plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Defines the `IFileStorageProvider` interface and ships two built-in providers: in-memory and OS filesystem.

## Install

```bash
npm install @qodalis/cli-server-plugin-filesystem
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import {
    FileSystemModule,
    InMemoryFileStorageProvider,
    OsFileStorageProvider,
} from '@qodalis/cli-server-plugin-filesystem';

const { app } = createCliServer({
    configure: (builder) => {
        builder.addModule(new FileSystemModule());

        // Use the in-memory provider (volatile, data lost on restart)
        builder.setFileStorageProvider(new InMemoryFileStorageProvider());

        // Or use the OS filesystem provider with path whitelisting
        builder.setFileStorageProvider(
            new OsFileStorageProvider({
                allowedPaths: ['/home/user/data'],
            }),
        );
    },
});
```

## Providers

| Provider | Name | Persistence | Description |
|---|---|---|---|
| `InMemoryFileStorageProvider` | `in-memory` | None (volatile) | Tree structure held in memory; fast but lost on restart |
| `OsFileStorageProvider` | `os` | Disk | Delegates to the host OS filesystem with path-traversal protection |

### OS Provider Options

| Option | Type | Description |
|---|---|---|
| `allowedPaths` | `string[]` | Absolute directory paths the provider is allowed to access |

The OS provider validates every path against the allowlist using `realpath` resolution, preventing symlink-based path traversal attacks.

## IFileStorageProvider Interface

All providers implement the `IFileStorageProvider` interface:

| Method | Description |
|---|---|
| `list(path)` | List entries in a directory |
| `readFile(path)` | Read file contents as UTF-8 |
| `writeFile(path, content)` | Create or overwrite a file |
| `stat(path)` | Get file or directory metadata |
| `mkdir(path, recursive?)` | Create a directory |
| `remove(path, recursive?)` | Remove a file or directory |
| `copy(src, dest)` | Copy a file or directory tree |
| `move(src, dest)` | Move (rename) a file or directory |
| `exists(path)` | Check whether a path exists |
| `getDownloadStream(path)` | Get a readable stream for file download |
| `uploadFile(path, content)` | Upload raw bytes to a file path |

## Custom Providers

Implement `IFileStorageProvider` to create your own storage backend. See the companion packages for examples:

- `@qodalis/cli-server-plugin-filesystem-json` -- JSON file persistence
- `@qodalis/cli-server-plugin-filesystem-s3` -- Amazon S3 storage
- `@qodalis/cli-server-plugin-filesystem-sqlite` -- SQLite database storage

## License

MIT
