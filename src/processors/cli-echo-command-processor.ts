import { CliCommandProcessor, CliProcessCommand } from '../abstractions';

/** Command processor that echoes back the input text verbatim. */
export class CliEchoCommandProcessor extends CliCommandProcessor {
    command = 'echo';
    description = 'Echoes back the input text';
    valueRequired = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return command.value ?? '';
    }
}
