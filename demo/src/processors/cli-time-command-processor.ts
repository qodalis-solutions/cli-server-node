import { CliCommandProcessor, CliCommandParameterDescriptor, CliProcessCommand } from '@qodalis/cli-server-node';

export class CliTimeCommandProcessor extends CliCommandProcessor {
    command = 'time';
    description = 'Shows the current server date and time';

    parameters = [
        new CliCommandParameterDescriptor('utc', 'Show time in UTC', false, 'boolean'),
        new CliCommandParameterDescriptor('format', 'Date/time format string', false, 'string', ['-f'], 'yyyy-MM-dd HH:mm:ss'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const useUtc = 'utc' in (command.args ?? {});
        const now = new Date();

        if (useUtc) {
            return `UTC: ${now.toISOString()}`;
        }

        return `Local: ${now.toLocaleString()}`;
    }
}
