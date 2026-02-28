import { CliCommandProcessor, CliProcessCommand } from '../abstractions';

export class CliEchoCommandProcessor extends CliCommandProcessor {
    command = 'echo';
    description = 'Echoes back the input text';
    valueRequired = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return command.value ?? '';
    }
}
