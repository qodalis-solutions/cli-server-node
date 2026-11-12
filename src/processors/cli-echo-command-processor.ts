import { CliCommandProcessor, CliProcessCommand, getPositionalText } from '../abstractions';

// The shell-word helpers live in the abstractions package so plugins can use them too
export { joinShellWords, splitShellWords } from '../abstractions';

/** Command processor that echoes back the input text, as a shell's echo prints it. */
export class CliEchoCommandProcessor extends CliCommandProcessor {
    command = 'echo';
    description = 'Echoes back the input text';
    examples = [
        { command: 'echo hello world', description: 'Prints hello world' },
    ];
    documentation =
        'Prints its input back as the server received it. Quoted words keep their spaces: echo "a  b" prints a  b.';
    valueRequired = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        // The positional words joined by one space: `echo "a" "b"` prints a b
        return getPositionalText(command);
    }
}
