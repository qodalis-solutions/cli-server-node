import { CliCommandProcessor, CliProcessCommand, joinShellWords } from '@qodalis/cli-server-node';

export class CliEchoCommandProcessor extends CliCommandProcessor {
    command = 'echo';
    description = 'Echoes back the input text';
    valueRequired = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        // `echo "a" "b"` prints a b, as the browser's echo does
        return joinShellWords(command.value ?? '');
    }
}
