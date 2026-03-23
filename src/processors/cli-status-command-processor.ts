import { CliCommandProcessor, CliProcessCommand } from '../abstractions';
import os from 'os';

/** Command processor that reports server status including uptime, OS, and Node.js version. */
export class CliStatusCommandProcessor extends CliCommandProcessor {
    command = 'status';
    description = 'Shows server status information';

    async handleAsync(_command: CliProcessCommand): Promise<string> {
        const uptime = Math.floor(process.uptime());
        return `Server: Running\nUptime: ${uptime}s\nOS: ${os.type()} ${os.release()}\nNode: ${process.version}`;
    }
}
