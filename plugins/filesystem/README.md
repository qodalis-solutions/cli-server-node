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

An allowed root itself can be listed and written into, but never removed, moved or used as a move target: `remove`, and `move` whose source or destination is an allowed root (after `realpath`, so a symlink to the root counts too), throw `PermissionDeniedError` (`403` on `DELETE /api/qcli/fs/rm`). Entries inside the root are unaffected.

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

## Dashboard page

The admin dashboard's Filesystem page is `@qodalis/cli-dashboard-module-filesystem`, copied into this package at build
(`dashboard/`, `npm run copy-dashboard`: the sibling `cli-server-dashboard/modules/filesystem/dist`, else the npm
package) and served at `/qcli/modules/filesystem` (outside the API, so the dashboard loads it without a token); it shows for
users with `files:read`. The server registers it when a file storage provider is set (it serves the filesystem API). `builder.setDashboardModuleDir('filesystem', dir)` serves another build, `false` leaves the page out.

## Terminal commands

No server-side command: the web CLI drives `/api/qcli/fs/*` (`files:read` for reading, `files:write` for changes on a
protected server) through [`@qodalis/cli-scp`](https://www.npmjs.com/package/@qodalis/cli-scp):

| Command | Permission | Does |
|---|---|---|
| `scp ls <server> <path>`, `scp cat <server> <path>`, `scp stat <server> <path>` | `files:read` | Lists a directory, prints a file, shows its details |
| `scp download <server> <remote> [local]` (`get`), `scp <server>:<remote> [local]` | `files:read` | Downloads into the virtual file system (`--save`: through the browser) |
| `scp upload <server> <local> <remote>` (`put`), `scp <local> <server>:<remote>` | `files:write` | Uploads from the virtual file system (`--local`: a file you pick) |
| `scp mkdir <server> <path>`, `scp rm <server> <path>` | `files:write` | Creates a directory, deletes a file |

The `ls`, `cat`, `cd`, ... commands of `@qodalis/cli-files` work on the browser's own file system, not the server's.
Allowed paths are a setting too: `config get filesystem` (core `config` command).

## License

MIT
