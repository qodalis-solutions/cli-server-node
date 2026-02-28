# Qodalis CLI Server (Node.js)

A Node.js CLI server framework for the [Qodalis CLI](https://github.com/qodalis-solutions/angular-web-cli) ecosystem. Built with Express.

## Installation

```bash
npm install @qodalis/cli-server-node
```

## Quick Start

### As a Library

```typescript
import { createCliServer, CliCommandProcessor, CliProcessCommand } from '@qodalis/cli-server-node';

class MyCommandProcessor extends CliCommandProcessor {
    command = 'greet';
    description = 'Says hello';

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return 'Hello from my server!';
    }
}

const { app, eventSocketManager } = createCliServer({
    configure: (builder) => {
        builder.addProcessor(new MyCommandProcessor());
    },
});

const server = app.listen(8047, () => {
    console.log('CLI server listening on http://localhost:8047');
});

eventSocketManager.attach(server);

process.on('SIGINT', async () => {
    await eventSocketManager.broadcastDisconnect();
    server.close();
    process.exit(0);
});
```

### As a Standalone Server

```bash
npx qodalis-cli-server
```

Or with environment variables:

```bash
PORT=9000 npx qodalis-cli-server
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cli/version` | Server version |
| GET | `/api/cli/commands` | List available commands |
| POST | `/api/cli/execute` | Execute a command |
| WS | `/ws/cli/events` | WebSocket event channel |

## Creating Command Processors

```typescript
import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
} from '@qodalis/cli-server-node';

class TimeCommandProcessor extends CliCommandProcessor {
    command = 'time';
    description = 'Shows the current server time';

    parameters = [
        new CliCommandParameterDescriptor('utc', 'Show time in UTC', false, 'boolean'),
        new CliCommandParameterDescriptor('format', 'Date/time format string', false, 'string', ['-f'], 'yyyy-MM-dd HH:mm:ss'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const useUtc = 'utc' in (command.args ?? {});
        const now = new Date();
        return useUtc ? `UTC: ${now.toISOString()}` : `Local: ${now.toLocaleString()}`;
    }
}
```

### Sub-commands

```typescript
class MathCommandProcessor extends CliCommandProcessor {
    command = 'math';
    description = 'Performs basic math operations';
    allowUnlistedCommands = false;

    processors = [
        new MathAddProcessor(),
        new MathMultiplyProcessor(),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return 'Usage: math add|multiply --a <number> --b <number>';
    }
}
```

## Docker

```bash
docker run -p 8047:8047 ghcr.io/qodalis-solutions/cli-server-node
```

The Docker image runs a demo server with sample processors (echo, status, time, hello, math).

## Demo

```bash
cd demo
npm install
npm start
# Server starts on http://localhost:8047
```

## Project Structure

```
src/
  abstractions/     # ICliCommandProcessor, CliProcessCommand, parameter descriptors
  models/           # CliServerOutput, CliServerResponse, command descriptors
  services/         # Registry, executor, response builder, WebSocket manager
  controllers/      # Express router for /api/cli routes
  extensions/       # CliBuilder fluent API
  processors/       # Built-in echo and status processors
  create-cli-server.ts  # Factory function for standalone/library use
  server.ts         # Standalone entry point
demo/               # Demo app with 5 sample processors
```

## License

MIT
