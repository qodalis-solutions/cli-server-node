import os from 'os';
import { CliCommandProcessor } from '../abstractions/cli-command-processor';
import { CliProcessCommand } from '../abstractions/cli-process-command';

const startTime = Date.now();

/** Command processor that displays detailed system information (hostname, OS, CPU, memory, uptime). */
export class CliSystemCommandProcessor extends CliCommandProcessor {
    command = 'system';
    description = 'Shows server system information';

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const uptimeSecs = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptimeSecs / 3600);
        const minutes = Math.floor((uptimeSecs % 3600) / 60);
        const seconds = uptimeSecs % 60;

        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
        const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);

        const lines = [
            `Hostname:      ${os.hostname()}`,
            `OS:            ${os.type()} ${os.release()}`,
            `Architecture:  ${os.arch()}`,
            `CPU Cores:     ${os.cpus().length}`,
            `Memory:        ${freeMem} GB free / ${totalMem} GB total`,
            `Node.js:       ${process.version}`,
            `Server Uptime: ${hours}h ${minutes}m ${seconds}s`,
        ];
        return lines.join('\n');
    }
}
