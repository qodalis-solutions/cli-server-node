import { describe, it, expect } from 'vitest';
import { splitShellWords, getPositionals, getPositionalText, quoteShellWord, CliProcessCommand } from '../abstractions';
import { CliBase64CommandProcessor } from '../processors/cli-base64-command-processor';
import { CliHashCommandProcessor } from '../processors/cli-hash-command-processor';
import { buildCliCommand } from '../mcp/providers/commands-provider';

function cmd(value: string | undefined, positionals?: string[], chain: string[] = []): CliProcessCommand {
    return { command: 'x', chainCommands: chain, rawCommand: '', value, args: {}, ...(positionals ? { positionals } : {}) };
}

describe('splitShellWords', () => {
    it('splits on whitespace and removes quotes', () => {
        expect(splitShellWords('a  b')).toEqual(['a', 'b']);
        expect(splitShellWords('"a b" c')).toEqual(['a b', 'c']);
        expect(splitShellWords("'a b'")).toEqual(['a b']);
        expect(splitShellWords('pre"a b"post')).toEqual(['prea bpost']);
        expect(splitShellWords('""')).toEqual(['']);
        expect(splitShellWords('')).toEqual([]);
        expect(splitShellWords('   ')).toEqual([]);
    });

    it('applies backslash escapes outside quotes', () => {
        expect(splitShellWords('my\\ file')).toEqual(['my file']);
        expect(splitShellWords('\\"a\\"')).toEqual(['"a"']);
        expect(splitShellWords('a\\\\b')).toEqual(['a\\b']);
        expect(splitShellWords('trailing\\')).toEqual(['trailing\\']);
    });

    it('applies only \\" and \\\\ escapes inside double quotes', () => {
        expect(splitShellWords('"say \\"hi\\""')).toEqual(['say "hi"']);
        expect(splitShellWords('"a\\\\b"')).toEqual(['a\\b']);
        expect(splitShellWords('"C:\\temp"')).toEqual(['C:\\temp']);
    });

    it('keeps single-quoted content as is', () => {
        expect(splitShellWords("'a\\\"b'")).toEqual(['a\\"b']);
        expect(splitShellWords('\'say "hi"\'')).toEqual(['say "hi"']);
    });

    it('treats an unclosed quote as text', () => {
        expect(splitShellWords('"a')).toEqual(['"a']);
        expect(splitShellWords("it's fine")).toEqual(["it's", 'fine']);
        expect(splitShellWords('"')).toEqual(['"']);
    });
});

describe('getPositionals', () => {
    it('prefers the positionals the browser sends', () => {
        expect(getPositionals(cmd('"a b" c', ['a b', 'c']))).toEqual(['a b', 'c']);
        expect(getPositionals(cmd('ignored', []))).toEqual([]);
    });

    it('falls back to splitting value for older browsers', () => {
        expect(getPositionals(cmd('"a b" c'))).toEqual(['a b', 'c']);
        expect(getPositionals(cmd(undefined))).toEqual([]);
        expect(getPositionalText(cmd('"a"   "b"'))).toBe('a b');
    });
});

describe('processors read unquoted positionals', () => {
    const encode = (c: CliProcessCommand) => new CliBase64CommandProcessor().processors[0].handleAsync(c);
    const ab = Buffer.from('a b').toString('base64');

    it('base64 encode "a b" encodes a b', async () => {
        expect(await encode(cmd('"a b"', ['a b'], ['encode']))).toBe(ab);
        expect(await encode(cmd('"a b"', undefined, ['encode']))).toBe(ab);
        expect(await encode(cmd('a b', ['a', 'b'], ['encode']))).toBe(ab);
    });

    it('base64 decode reads the positional', async () => {
        expect(await new CliBase64CommandProcessor().processors[1].handleAsync(cmd(`"${ab}"`))).toBe('a b');
    });

    it('hash "a b" hashes a b', async () => {
        const hash = new CliHashCommandProcessor();
        const expected = await hash.handleAsync(cmd('a b', ['a b']));
        expect(await hash.handleAsync(cmd('"a b"'))).toBe(expected);
        expect(await hash.handleAsync(cmd("'a b'", ['a b']))).toBe(expected);
    });
});

describe('quoteShellWord', () => {
    it('leaves plain values unquoted', () => {
        expect(quoteShellWord('hello')).toBe('hello');
        expect(quoteShellWord('https://x.io/a?b')).not.toBe('https://x.io/a?b'); // ? is special
        expect(quoteShellWord('a-b,c.d/e')).toBe('a-b,c.d/e');
    });

    it('picks double quotes, then single quotes, then escaped double quotes', () => {
        expect(quoteShellWord('a b')).toBe('"a b"');
        expect(quoteShellWord('')).toBe('""');
        expect(quoteShellWord("it's")).toBe('"it\'s"');
        expect(quoteShellWord('say "hi"')).toBe('\'say "hi"\'');
        expect(quoteShellWord('it\'s "x"')).toBe('"it\'s \\"x\\""');
        expect(quoteShellWord('-x')).toBe('"-x"');
    });

    it('round-trips through splitShellWords', () => {
        for (const v of ['plain', 'a b', '', "it's", 'say "hi"', 'it\'s "x"', 'C:\\temp\\', 'a\\"b \'c\'', '--flag', '  pad  ', '{"k": "v"}', 'x=y', 'a|b;c']) {
            expect(splitShellWords(quoteShellWord(v)), JSON.stringify(v)).toEqual([v]);
        }
    });
});

describe('MCP buildCliCommand', () => {
    it('quotes rawCommand for the browser parser and sets positionals from the tool arguments', () => {
        const c = buildCliCommand(['base64', 'encode'], true, { value: 'a "b"', mode: 'x y', on: true });
        expect(c.rawCommand).toBe('base64 encode \'a "b"\' --mode="x y" --on');
        expect(c.value).toBe('a "b"');
        expect(c.positionals).toEqual(['a "b"']);
        expect(c.args).toEqual({ mode: 'x y', on: true });
    });

    it('sends no positionals when there is no value', () => {
        const c = buildCliCommand(['status'], false, { verbose: false });
        expect(c.rawCommand).toBe('status --verbose=false');
        expect(c.positionals).toEqual([]);
    });
});
