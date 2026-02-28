import crypto from 'crypto';
import { CliCommandProcessor } from '../abstractions/cli-command-processor';
import { CliCommandParameterDescriptor } from '../abstractions/cli-command-parameter-descriptor';
import { CliProcessCommand } from '../abstractions/cli-process-command';

export class CliUuidCommandProcessor extends CliCommandProcessor {
    command = 'uuid';
    description = 'Generates random UUIDs';
    parameters = [
        new CliCommandParameterDescriptor('count', 'Number of UUIDs to generate (max 50)', false, 'number', ['-n'], '1'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        let count = parseInt(command.args?.count as string ?? '1', 10);
        count = Math.max(1, Math.min(count, 50));

        const uuids: string[] = [];
        for (let i = 0; i < count; i++) {
            uuids.push(crypto.randomUUID());
        }
        return uuids.join('\n');
    }
}
