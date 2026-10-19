import { CliCommandProcessor, CliProcessCommand } from '../abstractions';

/**
 * The arguments as a shell's echo prints them, as the browser CLI's own
 * `echo` does: quotes removed, the words joined by one space, spacing inside
 * quotes kept (`"a" "b"` -> `a b`). A quote without a closing one is text.
 */
export function joinShellWords(text: string): string {
    const words: string[] = [];
    let current = '';
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const end = ch === '"' || ch === "'" ? text.indexOf(ch, i + 1) : -1;
        if (end !== -1) {
            current += text.slice(i + 1, end);
            inWord = true;
            i = end;
        } else if (/\s/.test(ch)) {
            if (inWord) words.push(current);
            current = '';
            inWord = false;
        } else {
            current += ch;
            inWord = true;
        }
    }
    if (inWord) words.push(current);
    return words.join(' ');
}

/** Command processor that echoes back the input text, as a shell's echo prints it. */
export class CliEchoCommandProcessor extends CliCommandProcessor {
    command = 'echo';
    description = 'Echoes back the input text';
    valueRequired = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return joinShellWords(command.value ?? '');
    }
}
