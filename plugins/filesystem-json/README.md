# @qodalis/cli-server-plugin-filesystem-json

JSON file-backed storage provider for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Persists a virtual filesystem tree to a single JSON file on disk, providing simple file-based persistence without external dependencies.

## Install

```bash
npm install @qodalis/cli-server-plugin-filesystem-json
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { FileSystemModule } from '@qodalis/cli-server-plugin-filesystem';
import { JsonFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-json';

const { app } = createCliServer({
    configure: (builder) => {
        builder.addModule(new FileSystemModule());
        builder.setFileStorageProvider(
            new JsonFileStorageProvider({
                filePath: './data/filesystem.json',
            }),
        );
    },
});
```

## Configuration

| Option | Type | Description |
|---|---|---|
| `filePath` | `string` | Path to the JSON file that persists the virtual filesystem tree |

The entire tree is loaded into memory on construction and flushed to disk after every mutation (write, mkdir, remove, copy, move). The parent directory is created automatically if it does not exist.

## How It Works

The provider stores the complete directory tree as a nested JSON structure in a single file. This makes it easy to inspect, back up, and version-control the stored data. It is best suited for small to medium datasets where simplicity is preferred over performance.

## License

MIT
