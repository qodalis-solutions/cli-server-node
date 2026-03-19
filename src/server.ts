#!/usr/bin/env node

import { createCliServer } from './create-cli-server';
import { CliEchoCommandProcessor } from './processors/cli-echo-command-processor';
import { CliStatusCommandProcessor } from './processors/cli-status-command-processor';
import { CliSystemCommandProcessor } from './processors/cli-system-command-processor';
import { CliHttpCommandProcessor } from './processors/cli-http-command-processor';
import { CliHashCommandProcessor } from './processors/cli-hash-command-processor';
import { CliBase64CommandProcessor } from './processors/cli-base64-command-processor';
import { WeatherModule } from '@qodalis/cli-server-plugin-weather';

const port = process.env.PORT ?? 8047;

const { app, eventSocketManager } = createCliServer({
    configure: (builder) => {
        builder
            .addProcessor(new CliEchoCommandProcessor())
            .addProcessor(new CliStatusCommandProcessor())
            .addProcessor(new CliSystemCommandProcessor())
            .addProcessor(new CliHttpCommandProcessor())
            .addProcessor(new CliHashCommandProcessor())
            .addProcessor(new CliBase64CommandProcessor())
            .addModule(new WeatherModule());
    },
});

const server = app.listen(port, () => {
    console.log(`CLI server (Node.js) listening on http://localhost:${port}`);
    console.log(`  Commands:     http://localhost:${port}/api/v1/qcli/commands`);
    console.log(`  Execute:      http://localhost:${port}/api/v1/qcli/execute`);
    console.log(`  Capabilities: http://localhost:${port}/api/v1/qcli/capabilities`);
    console.log(`  Events:       ws://localhost:${port}/ws/v1/qcli/events`);
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
