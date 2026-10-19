import { describe, it, expect } from 'vitest';
import { CliEchoCommandProcessor, joinShellWords } from '../processors/cli-echo-command-processor';
import { CliProcessCommand } from '../abstractions';

function echo(value: string | undefined): Promise<string> {
    const command: CliProcessCommand = { command: 'echo', chainCommands: [], rawCommand: `echo ${value ?? ''}`, value, args: {} };
    return new CliEchoCommandProcessor().handleAsync(command);
}

describe('CliEchoCommandProcessor', () => {
    // The browser sends the positional text as typed, quotes included
    it('prints a quoted value without its quotes', async () => {
        expect(await echo('"hello world"')).toBe('hello world');
        expect(await echo("'a b'")).toBe('a b');
    });

    it('keeps flags inside quotes as text', async () => {
        expect(await echo('"a --b"')).toBe('a --b');
    });

    it('leaves unquoted and unpaired-quote text alone', async () => {
        expect(await echo('hello world')).toBe('hello world');
        expect(await echo('"a')).toBe('"a');
        expect(await echo('"a\'')).toBe('"a\'');
        expect(await echo('-')).toBe('-');
        expect(await echo(undefined)).toBe('');
    });

    it('joins several quoted words like a shell', async () => {
        expect(await echo('"a" "b"')).toBe('a b');
        expect(await echo('"a   b"  c')).toBe('a   b c');
        expect(await echo("it's fine")).toBe("it's fine");
    });

    it('joinShellWords handles a lone quote', () => {
        expect(joinShellWords('"')).toBe('"');
        expect(joinShellWords('""')).toBe('');
    });

    it('prints the positionals the browser sends, joined by one space', async () => {
        const command: CliProcessCommand = { command: 'echo', chainCommands: [], rawCommand: 'echo "a  b" c', value: '"a  b" c', positionals: ['a  b', 'c'], args: {} };
        expect(await new CliEchoCommandProcessor().handleAsync(command)).toBe('a  b c');
    });

    it('applies backslash escapes when splitting value', async () => {
        expect(await echo('my\\ file')).toBe('my file');
        expect(await echo('"say \\"hi\\""')).toBe('say "hi"');
    });
});
