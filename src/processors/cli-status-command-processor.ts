import { CliCommandProcessor, CliProcessCommand } from '../abstractions';
import os from 'os';

export class CliStatusCommandProcessor extends CliCommandProcessor {
    command = 'status';
    description = 'Shows server status information';

    async handleAsync(_command: CliProcessCommand): Promise<string> {
        const uptime = Math.floor(process.uptime());
        return `Server: Running\nUptime: ${uptime}s\nOS: ${os.type()} ${os.release()}\nNode: ${process.version}`;
    }
}
