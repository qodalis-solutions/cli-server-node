import {
    createCliServer,
    CliSystemCommandProcessor,
    CliHttpCommandProcessor,
    CliHashCommandProcessor,
    CliBase64CommandProcessor,
    CliUuidCommandProcessor,
} from '@qodalis/cli-server-node';
import { CliEchoCommandProcessor } from './processors/cli-echo-command-processor';
import { CliStatusCommandProcessor } from './processors/cli-status-command-processor';
import { CliTimeCommandProcessor } from './processors/cli-time-command-processor';
import { CliHelloCommandProcessor } from './processors/cli-hello-command-processor';
import { CliMathCommandProcessor } from './processors/cli-math-command-processor';
import { WeatherModule } from '../../plugins/weather';

const port = process.env.PORT ?? 8047;

const { app, eventSocketManager } = createCliServer({
    configure: (builder) => {
        builder
            .addProcessor(new CliEchoCommandProcessor())
            .addProcessor(new CliStatusCommandProcessor())
            .addProcessor(new CliTimeCommandProcessor())
            .addProcessor(new CliHelloCommandProcessor())
            .addProcessor(new CliMathCommandProcessor())
            .addProcessor(new CliSystemCommandProcessor())
            .addProcessor(new CliHttpCommandProcessor())
            .addProcessor(new CliHashCommandProcessor())
            .addProcessor(new CliBase64CommandProcessor())
            .addProcessor(new CliUuidCommandProcessor())
            .addModule(new WeatherModule())
            .addFileSystem({ allowedPaths: ['/tmp'] });
    },
});

const server = app.listen(port, () => {
    console.log(`CLI demo server (Node.js) listening on http://localhost:${port}`);
    console.log(`  Commands: http://localhost:${port}/api/cli/commands`);
    console.log(`  Execute:  http://localhost:${port}/api/cli/execute`);
    console.log(`  Events:   ws://localhost:${port}/ws/cli/events`);
});

eventSocketManager.attach(server);

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await eventSocketManager.broadcastDisconnect();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await eventSocketManager.broadcastDisconnect();
    server.close();
    process.exit(0);
});
