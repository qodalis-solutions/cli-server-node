import { CliProcessCommand } from './cli-process-command';

/** Index of the quote closing the one at `start`, or -1. In double quotes `\"` and `\\` are escapes. */
function closingQuote(text: string, start: number): number {
    const quote = text[start];
    for (let i = start + 1; i < text.length; i++) {
        if (quote === '"' && text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
            i++;
        } else if (text[i] === quote) {
            return i;
        }
    }
    return -1;
}

/**
 * Splits text into words like a shell, as the browser CLI does: whitespace
 * separates words, quotes are removed (`"a b"` is one word `a b`), a backslash
 * outside quotes escapes the next character (`my\ file` -> `my file`), and
 * inside double quotes `\"` and `\\` are escapes. Single quotes keep their
 * content as is. A quote without a closing one is text.
 */
export function splitShellWords(text: string): string[] {
    const words: string[] = [];
    let current = '';
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
            current += text[++i];
            inWord = true;
            continue;
        }
        const end = ch === '"' || ch === "'" ? closingQuote(text, i) : -1;
        if (end !== -1) {
            const inner = text.slice(i + 1, end);
            current += ch === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
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
    return words;
}

/**
 * The arguments as a shell's echo prints them, as the browser CLI's own
 * `echo` does: quotes removed, the words joined by one space, spacing inside
 * quotes kept (`"a" "b"` -> `a b`). A quote without a closing one is text.
 */
export function joinShellWords(text: string): string {
    return splitShellWords(text).join(' ');
}

/**
 * The positional arguments of a command, unquoted: `command.positionals` as the
 * browser sends it, or, from clients that do not send it, `command.value`
 * split with the same shell rules.
 */
export function getPositionals(command: Pick<CliProcessCommand, 'positionals' | 'value'>): string[] {
    if (Array.isArray(command.positionals)) return command.positionals.map((p) => String(p));
    return splitShellWords(command.value ?? '');
}

/** The positional arguments joined by one space (`base64 encode "a b"` -> `a b`); empty when there are none. */
export function getPositionalText(command: Pick<CliProcessCommand, 'positionals' | 'value'>): string {
    return getPositionals(command).join(' ');
}

/**
 * Quotes a word for a command line so `splitShellWords` (and the browser CLI's
 * parser) reads it back unchanged: as is when it has no spaces, quotes or
 * special characters; in double quotes when it has no `"`; in single quotes
 * when it has no `'`; otherwise in double quotes with `\"` and `\\` escapes.
 */
export function quoteShellWord(value: string): string {
    if (/^[^\s"'\\=|&;<>()$`*?#~-][^\s"'\\=|&;<>()$`*?#~]*$/.test(value)) return value;
    if (!value.includes('"')) return `"${value.replace(/\\/g, '\\\\')}"`;
    if (!value.includes("'")) return `'${value}'`;
    return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}
