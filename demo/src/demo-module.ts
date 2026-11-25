import { CliModule, ICliCommandProcessor } from '@qodalis/cli-server-node';
import { CliEchoCommandProcessor } from './processors/cli-echo-command-processor';
import { CliStatusCommandProcessor } from './processors/cli-status-command-processor';
import { CliTimeCommandProcessor } from './processors/cli-time-command-processor';
import { CliHelloCommandProcessor } from './processors/cli-hello-command-processor';
import { CliMathCommandProcessor } from './processors/cli-math-command-processor';

/**
 * The demo's own example commands (echo, status, time, hello, math) as one module: `GET /commands` lists them
 * with `module: "demo"`, and the dashboard's plugins page shows them as the demo plugin (enable/disable).
 */
export class DemoModule extends CliModule {
    name = 'demo';
    version = '1.0.0';
    description = 'Demo commands: examples of server-side commands';
    icon = '🧪';
    processors: ICliCommandProcessor[] = [
        new CliEchoCommandProcessor(),
        new CliStatusCommandProcessor(),
        new CliTimeCommandProcessor(),
        new CliHelloCommandProcessor(),
        new CliMathCommandProcessor(),
    ];
}
