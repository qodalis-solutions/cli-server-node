import { CliCommandProcessor, CliProcessCommand, getPositionalText } from '@qodalis/cli-server-node';

/** Command processor that echoes back the input text, as a shell's echo prints it. */
export class CliEchoCommandProcessor extends CliCommandProcessor {
    command = 'echo';
    description = 'Echoes back the input text';
    examples = [{ command: 'echo hello world', description: 'Prints hello world' }];
    documentation =
        'Prints its input back as the server received it. Quoted words keep their spaces: echo "a  b" prints a  b.';
    valueRequired = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        // `echo "a" "b"` prints a b, as the browser's echo does
        return getPositionalText(command);
    }
}
