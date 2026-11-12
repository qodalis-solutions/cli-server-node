import {
    DataExplorerCaller,
    DataExplorerLanguage,
    DataExplorerProviderOptions,
    DataExplorerResult,
    DataExplorerSchemaResult,
} from '@qodalis/cli-server-abstractions';

// The source options that keep data from leaking (spec: web-cli
// docs/superpowers/specs/2026-11-12-data-explorer-hardening-design.md).

/**
 * Whether a source only reads (`readOnly` defaults to true). Kept here rather than imported, so
 * this package works with older versions of the abstractions package.
 */
export function isReadOnly(options: Pick<DataExplorerProviderOptions, 'readOnly'>): boolean {
    return options.readOnly !== false;
}

/** A glob (`*` matches anything) as a case-insensitive regular expression. */
export function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
}

/** Whether `name` matches one of the glob `patterns`. */
export function matchesAny(name: string, patterns: readonly string[] | undefined): boolean {
    return !!patterns?.some((p) => globToRegExp(p).test(name));
}

/** The permissions of `options.requiredPermissions` the caller lacks (none on an open server). */
export function missingPermissions(
    permissions: readonly string[] | undefined,
    caller: DataExplorerCaller | undefined,
): string[] {
    if (!permissions?.length || !caller?.hasPermission) return [];
    return permissions.filter((p) => !caller.hasPermission!(p));
}

/** Whether the caller may use the source. */
export function canUseSource(options: DataExplorerProviderOptions, caller: DataExplorerCaller | undefined): boolean {
    return missingPermissions(options.requiredPermissions, caller).length === 0;
}

/** Whether the caller may export results of the source (advisory). */
export function canExport(options: DataExplorerProviderOptions, caller: DataExplorerCaller | undefined): boolean {
    return missingPermissions(options.exportPermissions, caller).length === 0;
}

// ── SQL tokens ──────────────────────────────────────────────────────

interface SqlToken {
    kind: 'word' | 'ident' | 'punct';
    /** Upper-case for words, as written for quoted identifiers. */
    value: string;
    /** As written (words keep their case for object names). */
    raw: string;
}

/**
 * How a dialect reads quotes and comments. The data explorer does not know which database a
 * `sql` source is, so a query is checked under the reading of each dialect ({@link SQL_READINGS}):
 * a quote or comment one dialect skips cannot hide a statement another one runs.
 */
export interface SqlReading {
    /** `\'` escapes a quote in strings (MySQL; Postgres without `standard_conforming_strings`). */
    backslashEscapes?: boolean;
    /** `"..."` is a string, not an identifier (MySQL without `ANSI_QUOTES`). */
    doubleQuotedStrings?: boolean;
    /** `E'...'` strings take backslash escapes (Postgres). */
    eStrings?: boolean;
    /** `$tag$ ... $tag$` strings (Postgres). */
    dollarQuotes?: boolean;
    /** `/* /* *\/ *\/` comments nest (Postgres, SQL Server). */
    nestedComments?: boolean;
    /** `#` starts a comment, `--` only before a space, and the text of `/*! ... *\/` runs (MySQL). */
    mysqlComments?: boolean;
    /** `[name]` is a quoted identifier (SQL Server, SQLite). */
    brackets?: boolean;
    /** A character from U+0080 up starts a name only when it is a letter (SQL Server). */
    unicodeLettersOnly?: boolean;
}

/**
 * MySQL (with and without `ANSI_QUOTES` and `NO_BACKSLASH_ESCAPES`), Postgres (with and without
 * `standard_conforming_strings`), SQL Server and SQLite.
 */
export const SQL_READINGS: readonly SqlReading[] = [
    { backslashEscapes: true, doubleQuotedStrings: true, mysqlComments: true },
    { backslashEscapes: true, doubleQuotedStrings: false, mysqlComments: true },
    { backslashEscapes: false, doubleQuotedStrings: true, mysqlComments: true },
    { backslashEscapes: false, doubleQuotedStrings: false, mysqlComments: true },
    { backslashEscapes: false, eStrings: true, dollarQuotes: true, nestedComments: true },
    { backslashEscapes: true, eStrings: true, dollarQuotes: true, nestedComments: true },
    { nestedComments: true, brackets: true, unicodeLettersOnly: true },
    { brackets: true },
];

/** A Postgres dollar quote: `$$` or `$tag$` (a tag is an identifier without `$`, digits after its first letter). */
const DOLLAR_QUOTE = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
const MYSQL_EXECUTABLE_COMMENT = /^\/\*M?!\d*/;

/** The index after the string whose opening quote is at `i` (a doubled quote is an escape); the end when not closed. */
function skipString(sql: string, i: number, quote: string, backslashEscapes: boolean): number {
    i++;
    while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) i += 2;
        else if (backslashEscapes && sql[i] === '\\') i += 2;
        else if (sql[i] === quote) return i + 1;
        else i++;
    }
    return sql.length;
}

/** The index after the `/* ... *\/` comment starting at `i`. */
function skipBlockComment(sql: string, i: number, nested: boolean): number {
    let depth = 0;
    while (i < sql.length) {
        if (sql.startsWith('/*', i) && (nested || depth === 0)) {
            depth++;
            i += 2;
        } else if (sql.startsWith('*/', i)) {
            depth--;
            i += 2;
            if (depth === 0) return i;
        } else {
            i++;
        }
    }
    return sql.length;
}

/** The name quoted at `i` (`"a""b"`, `[a]]b]`: a doubled closing character is an escape) and the index after it. */
function quotedIdentifier(sql: string, i: number, close: string): [string, number] {
    let name = '';
    let j = i + 1;
    while (j < sql.length) {
        const end = sql.indexOf(close, j);
        if (end < 0) return [name + sql.slice(j), sql.length];
        name += sql.slice(j, end);
        if (sql[end + 1] === close) {
            name += close;
            j = end + 2;
            continue;
        }
        return [name, end + 1];
    }
    return [name, sql.length];
}

/**
 * Splits SQL into words, quoted identifiers and punctuation; comments and string literals
 * are dropped, so keywords inside them do not count. A `"..."` string (MySQL without
 * `ANSI_QUOTES`) stays a single name token, so it never hides a keyword and still names what it quotes.
 */
export function tokenizeSql(sql: string, reading: SqlReading = SQL_READINGS[0]): SqlToken[] {
    const tokens: SqlToken[] = [];
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        const next = sql[i + 1];
        if (c === '-' && next === '-' && (!reading.mysqlComments || i + 2 >= sql.length || /\s/.test(sql[i + 2]) || sql.charCodeAt(i + 2) < 32)) {
            // Line comment (MySQL needs a space after `--`: `1--1` is 1 - -1)
            while (i < sql.length && sql[i] !== '\n') i++;
            continue;
        }
        if (c === '#' && reading.mysqlComments) {
            // MySQL line comment (`#t` is a SQL Server temp table, `#` a Postgres operator)
            while (i < sql.length && sql[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && next === '*') {
            const executable = reading.mysqlComments ? MYSQL_EXECUTABLE_COMMENT.exec(sql.slice(i)) : null;
            // MySQL runs the text of /*! ... */ (its */ is read as punctuation)
            i = executable ? i + executable[0].length : skipBlockComment(sql, i, !!reading.nestedComments);
            continue;
        }
        if (c === '"' && reading.doubleQuotedStrings) {
            // A string here, but every other dialect reads a name, and a string cannot stand where a table or a
            // column does: kept as that name, so FROM "Users" u WHERE ... still names the table, not WHERE or u
            const end = skipString(sql, i, c, !!reading.backslashEscapes);
            const name = sql.slice(i + 1, Math.max(i + 1, end - 1)).replace(/""/g, '"');
            tokens.push({ kind: 'ident', value: name, raw: name });
            i = end;
            continue;
        }
        if (c === "'") {
            i = skipString(sql, i, c, !!reading.backslashEscapes);
            continue;
        }
        if (c === '$' && reading.dollarQuotes) {
            // Postgres dollar-quoted string: $tag$ ... $tag$
            const m = DOLLAR_QUOTE.exec(sql.slice(i));
            if (m) {
                const end = sql.indexOf(m[0], i + m[0].length);
                i = end < 0 ? sql.length : end + m[0].length;
                continue;
            }
        }
        if (c === '"' || c === '`' || (c === '[' && reading.brackets)) {
            const [name, end] = quotedIdentifier(sql, i, c === '[' ? ']' : c);
            tokens.push({ kind: 'ident', value: name, raw: name });
            i = end;
            continue;
        }
        if (/[A-Za-z_]/.test(c) || (c >= '\u0080' && (!reading.unicodeLettersOnly || /\p{L}/u.test(c)))) {
            // Names may hold non-ASCII letters (`café`): one name, not punctuation before a quote
            let j = i + 1;
            while (j < sql.length && (/[A-Za-z0-9_$]/.test(sql[j]) || (sql[j] >= '\u0080' && /[\p{L}\p{N}]/u.test(sql[j])))) j++;
            const raw = sql.slice(i, j);
            if (reading.eStrings && (raw === 'E' || raw === 'e') && sql[j] === "'") {
                // Postgres escape string: E'it\'s'
                i = skipString(sql, j, "'", true);
                continue;
            }
            tokens.push({ kind: 'word', value: raw.toUpperCase(), raw });
            i = j;
            continue;
        }
        if (/\s/.test(c) || /[0-9]/.test(c)) {
            i++;
            continue;
        }
        tokens.push({ kind: 'punct', value: c, raw: c });
        i++;
    }
    return tokens;
}

const SQL_READ_STARTS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE']);
const SQL_WRITE_WORDS = new Set([
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT',
    'REVOKE', 'DENY', 'COPY', 'CALL', 'EXEC', 'EXECUTE', 'INTO', 'LOCK', 'VACUUM', 'ATTACH', 'DETACH', 'PRAGMA', 'SET',
    // SQL Server runs statements without `;` between them: `SELECT 1 COMMIT …` would keep what follows
    'COMMIT', 'ROLLBACK',
]);
/** Write keywords that are also read-only functions when a `(` follows (`REPLACE(name, 'a', 'b')`). */
const SQL_FUNCTION_WORDS = new Set(['REPLACE', 'INSERT']);

/** A carriage return not followed by a newline: Postgres ends a `--` comment there, the other databases do not. */
const LONE_CARRIAGE_RETURN = /\r(?!\n)/;

function sqlReadOnlyError(query: string): string | undefined {
    if (LONE_CARRIAGE_RETURN.test(query)) return 'Read-only source: end lines with \\n or \\r\\n';
    for (const reading of SQL_READINGS) {
        const error = sqlReadOnlyErrorAs(query, reading);
        if (error) return error;
    }
    return undefined;
}

function sqlReadOnlyErrorAs(query: string, reading: SqlReading): string | undefined {
    const tokens = tokenizeSql(query, reading);
    const statements: SqlToken[][] = [[]];
    for (const t of tokens) {
        if (t.kind === 'punct' && t.value === ';') statements.push([]);
        else statements[statements.length - 1].push(t);
    }
    const nonEmpty = statements.filter((s) => s.length > 0);
    if (nonEmpty.length !== 1) return 'Read-only source: run one statement at a time';
    const statement = nonEmpty[0];
    const first = statement[0];
    if (first.kind !== 'word' || !SQL_READ_STARTS.has(first.value)) {
        return 'Read-only source: only SELECT, WITH, EXPLAIN, SHOW, DESCRIBE, VALUES or TABLE queries are allowed';
    }
    for (let i = 0; i < statement.length; i++) {
        const t = statement[i];
        if (t.kind !== 'word' || !SQL_WRITE_WORDS.has(t.value)) continue;
        if (SQL_FUNCTION_WORDS.has(t.value) && statement[i + 1]?.value === '(') continue;
        return `Read-only source: ${t.value} is not allowed`;
    }
    return undefined;
}

/** Functions whose arguments use FROM without naming a table (`EXTRACT(YEAR FROM day)`). */
const SQL_FROM_FUNCTIONS = new Set(['EXTRACT', 'SUBSTRING', 'SUBSTR', 'TRIM', 'POSITION', 'OVERLAY']);
const SQL_OBJECT_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);
/** Words that end a FROM or USING list at its own depth. */
const SQL_LIST_END_WORDS = new Set([
    'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FETCH', 'FOR',
    'RETURNING', 'SELECT', 'FROM', 'QUALIFY', 'OPTION', 'INTO', 'SET', 'VALUES',
]);
/** Words after a leading EXPLAIN, DESCRIBE or DESC that do not name a table (`EXPLAIN ANALYZE SELECT …`). */
const SQL_EXPLAIN_WORDS = new Set([
    'SELECT', 'WITH', 'ANALYZE', 'VERBOSE', 'FORMAT', 'EXTENDED', 'PARTITIONS', 'QUERY', 'TABLE', 'VALUES', 'FOR',
    'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE',
]);

/** The tables a SQL query names (after FROM, JOIN, INTO, UPDATE, TABLE), without the CTE names it defines. */
export function sqlObjects(query: string): string[] {
    const all = new Set<string>();
    for (const reading of SQL_READINGS) for (const o of walkSqlObjects(tokenizeSql(query, reading)).objects) all.add(o);
    return [...all];
}

/**
 * The tables the tokens name (without CTE names); the lower-case names a row of them goes by
 * (tables, CTEs, aliases); and the indices of the tokens that name or alias them.
 */
function walkSqlObjects(tokens: SqlToken[]): { objects: string[]; rowNames: Set<string>; defined: Set<number> } {
    const isName = (t: SqlToken | undefined) => !!t && (t.kind === 'ident' || t.kind === 'word');
    const isPunct = (t: SqlToken | undefined, value: string) => t?.kind === 'punct' && t.value === value;
    // Parenthesis depth of each token (a parenthesis has the depth outside it)
    const depthAt: number[] = [];
    let depth = 0;
    for (const t of tokens) {
        if (isPunct(t, ')')) depth--;
        depthAt.push(depth);
        if (isPunct(t, '(')) depth++;
    }
    // CTE names: name [ (columns) ] AS ( — they stand for a table only until the end of the
    // parentheses (or the statement) they are defined in
    const ctes: { name: string; start: number; end: number }[] = [];
    const defined = new Set<number>();
    for (let i = 0; i < tokens.length; i++) {
        if (!isName(tokens[i])) continue;
        let j = i + 1;
        if (isPunct(tokens[j], '(')) {
            let level = 0;
            for (; j < tokens.length; j++) {
                if (isPunct(tokens[j], '(')) level++;
                else if (isPunct(tokens[j], ')') && --level === 0) break;
            }
            j++;
        }
        if (tokens[j]?.value === 'AS' && isPunct(tokens[j + 1], '(')) {
            let end = i + 1;
            while (end < tokens.length && !isPunct(tokens[end], ';') && !(isPunct(tokens[end], ')') && depthAt[end] < depthAt[i])) end++;
            ctes.push({ name: tokens[i].raw.toLowerCase(), start: i, end });
            defined.add(i);
        }
    }
    const isCte = (name: string, at: number) => ctes.some((c) => c.name === name && at > c.start && at < c.end);

    const objects: string[] = [];
    const rowNames = new Set<string>(ctes.map((c) => c.name));
    const openers: (string | undefined)[] = [];
    // A dotted name; `..` is an empty part (`db..table`, SQL Server's default schema)
    const readName = (start: number): [string, number] | undefined => {
        if (!isName(tokens[start])) return undefined;
        const parts = [tokens[start].raw];
        let k = start + 1;
        while (isPunct(tokens[k], '.')) {
            if (isName(tokens[k + 1])) {
                parts.push(tokens[k + 1].raw);
                k += 2;
            } else if (isPunct(tokens[k + 1], '.')) {
                parts.push('');
                k++;
            } else {
                break;
            }
        }
        return [parts.join('.'), k];
    };
    // A table (with its alias) at `k`; in a FROM or USING list `f(…)` is a function, not a table.
    // Returns the index after it.
    const readTable = (k: number, inList: boolean): number => {
        if (tokens[k]?.kind === 'word' && (tokens[k].value === 'ONLY' || tokens[k].value === 'LATERAL')) k++;
        const name = readName(k);
        if (!name || (inList && isPunct(tokens[name[1]], '('))) return k;
        if (!isCte(name[0].toLowerCase(), k)) objects.push(name[0]);
        rowNames.add(name[0].split('.').pop()!.toLowerCase());
        for (let d = k; d < name[1]; d++) defined.add(d);
        k = name[1];
        // An alias: [AS] alias
        if (tokens[k]?.value === 'AS') {
            if (isName(tokens[k + 1])) {
                rowNames.add(tokens[k + 1].raw.toLowerCase());
                defined.add(k + 1);
            }
            k += 2;
        } else if (tokens[k]?.kind === 'word' && !SQL_CLAUSE_WORDS.has(tokens[k].value) && !SQL_LIST_END_WORDS.has(tokens[k].value)) {
            rowNames.add(tokens[k].raw.toLowerCase());
            defined.add(k);
            k++;
        }
        return k;
    };
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (isPunct(t, '(')) {
            openers.push(tokens[i - 1]?.kind === 'word' ? tokens[i - 1].value : undefined);
            continue;
        }
        if (isPunct(t, ')')) {
            openers.pop();
            continue;
        }
        if (t.kind !== 'word') continue;
        const statementStart = i === 0 || isPunct(tokens[i - 1], ';');
        if (statementStart && (t.value === 'DESCRIBE' || t.value === 'DESC' || t.value === 'EXPLAIN')) {
            const next = tokens[i + 1];
            if (isName(next) && !(next.kind === 'word' && SQL_EXPLAIN_WORDS.has(next.value))) readTable(i + 1, false);
            continue;
        }
        if (t.value === 'FROM' || t.value === 'USING') {
            if (t.value === 'FROM' && SQL_FROM_FUNCTIONS.has(openers[openers.length - 1] ?? '')) continue;
            // Every item of the list: a table, a subquery or a function, up to the next `,` at this depth
            let k = i + 1;
            for (;;) {
                k = readTable(k, true);
                let level = 0;
                let next = -1;
                for (; k < tokens.length; k++) {
                    const u = tokens[k];
                    if (isPunct(u, '(')) level++;
                    else if (isPunct(u, ')')) {
                        if (level === 0) break;
                        level--;
                    } else if (isPunct(u, ';')) break;
                    else if (level === 0 && isPunct(u, ',')) {
                        next = k + 1;
                        break;
                    } else if (level === 0 && u.kind === 'word' && SQL_LIST_END_WORDS.has(u.value)) break;
                }
                if (next < 0) break;
                k = next;
            }
            continue;
        }
        if (SQL_OBJECT_KEYWORDS.has(t.value)) readTable(i + 1, false);
    }
    return { objects, rowNames, defined };
}

const SQL_CLAUSE_WORDS = new Set([
    'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING',
    'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FETCH', 'FOR', 'NATURAL', 'SET', 'VALUES',
    'SELECT', 'RETURNING', 'TABLESAMPLE', 'WITH',
]);

// ── Masked columns ──────────────────────────────────────────────────

/** Words never taken for column names when checking masked columns. */
const SQL_KEYWORDS = new Set([
    ...SQL_READ_STARTS, ...SQL_WRITE_WORDS, ...SQL_OBJECT_KEYWORDS, ...SQL_CLAUSE_WORDS,
    'AS', 'DISTINCT', 'ALL', 'TOP', 'BY', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'EXISTS', 'ANY', 'SOME', 'TRUE', 'FALSE', 'ONLY', 'LATERAL',
]);
/** What may come right before a masked column in the select list. */
const SELECT_ITEM_BEFORE = new Set(['SELECT', 'DISTINCT', 'ALL', 'TOP', ',']);
const SET_OPERATIONS = new Set(['UNION', 'EXCEPT', 'INTERSECT', 'MINUS']);
/** Postgres identifiers with Unicode escapes (`U&"\0065mail"`, `UESCAPE`). */
const UNICODE_IDENTIFIER = /[Uu]&"/;
export const UNICODE_IDENTIFIER_MESSAGE = 'This source masks columns: write names without Unicode escapes (U&"...")';

export function maskedColumnMessage(name: string): string {
    return `Masked column '${name}' can only be selected by its own name`;
}

export function wholeRowMessage(name: string): string {
    return `'${name}' is a whole row and this source masks columns: select its columns by name`;
}

/**
 * The masked or dropped columns a SQL query names, each with whether every mention, under every
 * reading, is a plain item of the outer select list (`SELECT email`, `SELECT u.email,`): outside
 * parentheses, before the first `FROM`, followed by `,`, `FROM` or the end, in a query without
 * `UNION`/`EXCEPT`/`INTERSECT`/`MINUS`. `refused` refuses the query outright: a whole row used as
 * a value (Postgres `SELECT u FROM users u`, `row_to_json(u)`) or a Unicode-escaped name.
 */
function maskedScan(
    options: DataExplorerProviderOptions,
    query: string,
): { references: { name: string; plain: boolean }[]; refused?: string } {
    const patterns = [...(options.maskColumns ?? []), ...(options.dropColumns ?? [])];
    if (!patterns.length || options.language !== DataExplorerLanguage.Sql) return { references: [] };
    if (UNICODE_IDENTIFIER.test(query)) return { references: [], refused: UNICODE_IDENTIFIER_MESSAGE };
    // lower-case name → as first written, every mention plain
    const found = new Map<string, { name: string; plain: boolean }>();
    for (const reading of SQL_READINGS) {
        const tokens = tokenizeSql(query, reading);
        const { rowNames, defined } = walkSqlObjects(tokens);
        const setOperation = tokens.some((t) => t.kind === 'word' && SET_OPERATIONS.has(t.value));
        let depth = 0;
        let inSelectList = false;
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.kind === 'punct' && t.value === '(') {
                depth++;
                continue;
            }
            if (t.kind === 'punct' && t.value === ')') {
                depth--;
                continue;
            }
            if (t.kind === 'punct' && t.value === ';') {
                inSelectList = false;
                continue;
            }
            if (depth === 0 && t.kind === 'word' && (t.value === 'SELECT' || t.value === 'FROM')) {
                inSelectList = t.value === 'SELECT';
            }
            if (defined.has(i) || t.kind === 'punct' || (t.kind === 'word' && SQL_KEYWORDS.has(t.value))) continue;
            const next = tokens[i + 1];
            // A qualifier (`u.`) or a function (`upper(`)
            if (next?.kind === 'punct' && (next.value === '.' || next.value === '(')) continue;
            const prev = tokens[i - 1];
            const qualified = prev?.kind === 'punct' && prev.value === '.';
            if (!qualified && rowNames.has(t.raw.toLowerCase())) {
                return { references: [], refused: wholeRowMessage(t.raw) };
            }
            if (!matchesAny(t.raw, patterns)) continue;
            const k = qualified && i >= 2 && tokens[i - 2].kind !== 'punct' ? i - 2 : i;
            const before = k >= 1 ? tokens[k - 1].value : undefined;
            const plain =
                depth === 0 &&
                inSelectList &&
                !setOperation &&
                before !== undefined &&
                SELECT_ITEM_BEFORE.has(before) &&
                (next === undefined || [',', 'FROM', ';'].includes(next.value));
            const key = t.raw.toLowerCase();
            const seen = found.get(key);
            found.set(key, { name: seen?.name ?? t.raw, plain: (seen?.plain ?? true) && plain });
        }
    }
    return { references: [...found.values()] };
}

/**
 * Why a SQL query is refused under `maskColumns`/`dropColumns` (before it runs): it names a masked
 * or dropped column other than as a plain item of the select list (`SELECT email AS e`,
 * `upper(email)`, `WHERE email = ...`), uses a whole row as a value, or escapes a name.
 */
export function maskedColumnError(options: DataExplorerProviderOptions, query: string): string | undefined {
    const { references, refused } = maskedScan(options, query);
    if (refused) return refused;
    const named = references.find((r) => !r.plain);
    return named ? maskedColumnMessage(named.name) : undefined;
}

/**
 * Why a result is withheld: a masked or dropped column the query selects is missing from the
 * result's columns (it came back under another name, e.g. SQL Server `FOR JSON`). `columns` are
 * the result's columns before masking.
 */
export function maskedResultError(
    options: DataExplorerProviderOptions,
    query: string,
    columns: readonly string[] | null | undefined,
): string | undefined {
    const names = new Set((columns ?? []).map((c) => String(c).toLowerCase()));
    const missing = maskedScan(options, query).references.find((r) => !names.has(r.name.toLowerCase()));
    return missing ? maskedColumnMessage(missing.name) : undefined;
}

// ── MongoDB ─────────────────────────────────────────────────────────

const MONGO_READ_METHODS = new Set(['find', 'findone', 'countdocuments', 'estimateddocumentcount', 'distinct', 'aggregate']);
const MONGO_SHOW = /^show\s+(collections|dbs|databases)\s*;?$/i;
const MONGO_CALL = /^db\.(?:getCollection\(\s*['"]([^'"]+)['"]\s*\)|([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*?))\.(\w+)\s*\(/;

/** `\uXXXX` escapes decoded, as the driver reads them (`"\u0024out"` is `$out`). */
function decodeJsonEscapes(text: string): string {
    return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function mongoReadOnlyError(query: string): string | undefined {
    const q = decodeJsonEscapes(query.trim());
    if (MONGO_SHOW.test(q)) return undefined;
    const m = MONGO_CALL.exec(q);
    if (!m || !MONGO_READ_METHODS.has(m[3].toLowerCase())) {
        return 'Read-only source: only find, findOne, countDocuments, estimatedDocumentCount, distinct and aggregate are allowed';
    }
    if (m[3].toLowerCase() === 'aggregate' && /["']?\$(out|merge)["']?\s*:/.test(q)) {
        return 'Read-only source: $out and $merge are not allowed';
    }
    return undefined;
}

/** Pipeline stages that read or write other collections. */
const MONGO_COLLECTION_STAGES = /\$(lookup|graphLookup|unionWith|out|merge)/;
/** A key naming a collection in those stages: a string value is one, `{` nests, anything else cannot be told. */
const MONGO_STAGE_COLLECTION = /["']?(?:\b(?:from|coll|into)|\$(?:unionWith|out|merge))["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|(\{))?/g;

function mongoObjects(query: string): string[] | undefined {
    const q = decodeJsonEscapes(query.trim());
    if (MONGO_SHOW.test(q)) return [];
    const m = MONGO_CALL.exec(q);
    if (!m) return undefined;
    const objects = [m[1] ?? m[2]];
    if (MONGO_COLLECTION_STAGES.test(q)) {
        for (const stage of q.matchAll(MONGO_STAGE_COLLECTION)) {
            if (stage[1] !== undefined || stage[2] !== undefined) objects.push(stage[1] ?? stage[2]);
            else if (stage[3] === undefined) return undefined;
        }
    }
    return objects;
}

// ── Redis ───────────────────────────────────────────────────────────

const REDIS_READ = new Set([
    'GET', 'MGET', 'STRLEN', 'GETRANGE', 'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'LRANGE',
    'LLEN', 'LINDEX', 'SMEMBERS', 'SCARD', 'SISMEMBER', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZCARD', 'ZSCORE',
    'TTL', 'PTTL', 'EXISTS', 'TYPE', 'KEYS', 'SCAN', 'INFO', 'DBSIZE', 'PING',
]);
const REDIS_NO_KEYS = new Set(['INFO', 'DBSIZE', 'PING']);
/** Commands whose every argument is a key. */
const REDIS_ALL_KEYS = new Set(['MGET', 'EXISTS', 'DEL', 'UNLINK', 'TOUCH']);

/** The words of a Redis command, split as the provider splits them: quotes group, join the text around them, no escapes. */
function redisWords(query: string): string[] {
    const words: string[] = [];
    let word = '';
    let quote: string | undefined;
    for (const c of query.trim()) {
        if (quote) {
            if (c === quote) quote = undefined;
            else word += c;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (/\s/.test(c)) {
            if (word) words.push(word);
            word = '';
        } else {
            word += c;
        }
    }
    if (word) words.push(word);
    return words;
}

function redisReadOnlyError(query: string): string | undefined {
    const command = redisWords(query)[0]?.toUpperCase();
    return command && REDIS_READ.has(command) ? undefined : `Read-only source: ${command ?? 'this command'} is not allowed`;
}

/** The keys (or key patterns) a Redis command names; undefined when it may touch any key. */
function redisObjects(query: string): string[] | undefined {
    const [command, ...args] = redisWords(query);
    const cmd = command?.toUpperCase();
    if (!cmd) return [];
    if (REDIS_NO_KEYS.has(cmd)) return [];
    if (cmd === 'SCAN') {
        const match = args.findIndex((a) => a.toUpperCase() === 'MATCH');
        return match >= 0 && args[match + 1] ? [args[match + 1]] : undefined;
    }
    if (cmd === 'KEYS') return args[0] ? [args[0]] : undefined;
    if (REDIS_ALL_KEYS.has(cmd)) return args;
    if (cmd === 'MSET') return args.filter((_, i) => i % 2 === 0);
    return args[0] ? [args[0]] : [];
}

// ── Elasticsearch ───────────────────────────────────────────────────

/** POST endpoints that only read, after the index names. */
const ES_READ_POST = /^(.*)\/(_search|_count|_msearch|_mget|_field_caps|_validate\/query)$/;

/** The verb and the bare path (cut at `?` or `#`: the HTTP client drops the fragment). */
function esRequestLine(query: string): { verb: string; path: string } {
    const first = query.trim().split('\n')[0].trim();
    const m = /^(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S+)/i.exec(first);
    const verb = m ? m[1].toUpperCase() : 'GET';
    const raw = m ? m[2] : first;
    return { verb, path: (raw.startsWith('/') ? raw : `/${raw}`).split(/[?#]/)[0] };
}

function esReadOnlyError(query: string): string | undefined {
    const { verb, path } = esRequestLine(query);
    if (verb === 'GET' || verb === 'HEAD') return undefined;
    const m = ES_READ_POST.exec(path);
    // Only index names before the endpoint: `/logs/_doc/_search` indexes a document
    if (verb === 'POST' && m && m[1].split('/').filter(Boolean).every((s) => !s.startsWith('_') || s === '_all')) return undefined;
    return `Read-only source: ${verb} ${path} is not allowed`;
}

function esObjects(query: string): string[] | undefined {
    const { path } = esRequestLine(query);
    const first = path.split('/').filter(Boolean)[0];
    if (!first || first.startsWith('_')) return undefined;
    // `_msearch` headers, `_mget` docs and terms lookups name indices in the body
    const body = decodeJsonEscapes(query.trim().split('\n').slice(1).join('\n'));
    if (/"_?index"\s*:/.test(body)) return undefined;
    return first.split(',');
}

// ── Checks ──────────────────────────────────────────────────────────

/** Why a read-only source refuses the query, or undefined when it only reads. */
export function readOnlyError(language: DataExplorerLanguage | string, query: string): string | undefined {
    switch (language) {
        case DataExplorerLanguage.Sql:
            return sqlReadOnlyError(query);
        case DataExplorerLanguage.Shell:
        case DataExplorerLanguage.Json:
            // MongoDB sources use either language
            return mongoReadOnlyError(query);
        case DataExplorerLanguage.Redis:
            return redisReadOnlyError(query);
        case DataExplorerLanguage.Elasticsearch:
            return esReadOnlyError(query);
        default:
            return `Read-only source: ${language} queries cannot be checked; set readOnly: false to allow them`;
    }
}

/** The objects a query names, by language; undefined when they cannot be told (then refused under `allowedObjects`). */
export function queryObjects(language: DataExplorerLanguage | string, query: string): string[] | undefined {
    switch (language) {
        case DataExplorerLanguage.Sql:
            // A lone carriage return: the objects cannot be told (see sqlReadOnlyError)
            return LONE_CARRIAGE_RETURN.test(query) ? undefined : sqlObjects(query);
        case DataExplorerLanguage.Shell:
        case DataExplorerLanguage.Json:
            return mongoObjects(query);
        case DataExplorerLanguage.Redis:
            return redisObjects(query);
        case DataExplorerLanguage.Elasticsearch:
            return esObjects(query);
        default:
            return undefined;
    }
}

/**
 * Whether an object name is allowed: a pattern with a dot matches the qualified name, one
 * without matches the last part (a table in any schema). Redis key patterns and Elasticsearch
 * index patterns in the query are matched as written (`rates:*` is allowed by `rates:*`, `*` is not).
 */
export function isObjectAllowed(name: string, patterns: readonly string[]): boolean {
    const last = name.split('.').pop() ?? name;
    return patterns.some((p) => globToRegExp(p).test(p.includes('.') ? name : last) || globToRegExp(p).test(name));
}

/** Why the query is refused under `allowedObjects`, or undefined. */
export function objectsError(options: DataExplorerProviderOptions, query: string): string | undefined {
    const patterns = options.allowedObjects;
    if (!patterns?.length) return undefined;
    const objects = queryObjects(options.language, query);
    if (objects === undefined) return 'This source only accepts queries that name the objects they read';
    const denied = objects.find((o) => !isObjectAllowed(o, patterns));
    return denied ? `'${denied}' is not available on this source` : undefined;
}

// ── Results ─────────────────────────────────────────────────────────

export const MASK = '***';

function maskObject(value: unknown, mask: readonly string[], drop: readonly string[]): unknown {
    if (typeof value === 'string') return maskJsonText(value, mask, drop);
    if (Array.isArray(value)) return value.map((v) => maskObject(v, mask, drop));
    if (value === null || typeof value !== 'object' || value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (matchesAny(key, drop)) continue;
        out[key] = matchesAny(key, mask) ? (v === null || v === undefined ? v : MASK) : maskObject(v, mask, drop);
    }
    return out;
}

/**
 * A string holding a JSON object or array (a JSON column, an Elasticsearch answer) masked like a
 * document and written back compact; kept as written when nothing changed or it is not JSON.
 */
function maskJsonText(text: string, mask: readonly string[], drop: readonly string[]): string {
    const start = text.trimStart()[0];
    if (start !== '{' && start !== '[') return text;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return text;
    }
    if (parsed === null || typeof parsed !== 'object') return text;
    const masked = JSON.stringify(maskObject(parsed, mask, drop));
    return masked === JSON.stringify(parsed) ? text : masked;
}

/** Masks and drops columns (`maskColumns`, `dropColumns`) in a result, in place; returns it. */
export function applyColumnPolicy(result: DataExplorerResult, options: DataExplorerProviderOptions): DataExplorerResult {
    const mask = options.maskColumns ?? [];
    const drop = options.dropColumns ?? [];
    if (!mask.length && !drop.length) return result;
    if (result.columns) {
        const keep = result.columns.map((c) => !matchesAny(c, drop));
        const masked = result.columns.map((c) => matchesAny(c, mask));
        result.columns = result.columns.filter((_, i) => keep[i]);
        result.rows = (result.rows as unknown[]).map((row) =>
            Array.isArray(row)
                ? row
                      .map((v, i) => (masked[i] && v !== null && v !== undefined ? MASK : maskObject(v, mask, drop)))
                      .filter((_, i) => keep[i])
                : maskObject(row, mask, drop),
        ) as DataExplorerResult['rows'];
    } else {
        result.rows = (result.rows as unknown[]).map((row) => maskObject(row, mask, drop)) as DataExplorerResult['rows'];
    }
    return result;
}

/** The schema as the source shows it: allowed tables only, without dropped columns. */
export function filterSchema(schema: DataExplorerSchemaResult, options: DataExplorerProviderOptions): DataExplorerSchemaResult {
    const allowed = options.allowedObjects;
    const drop = options.dropColumns ?? [];
    return {
        ...schema,
        tables: schema.tables
            .filter((t) => !allowed?.length || isObjectAllowed(t.name, allowed))
            .map((t) => (drop.length ? { ...t, columns: t.columns.filter((c) => !matchesAny(c.name, drop)) } : t)),
    };
}

/** `show collections` (MongoDB) lists only the allowed collections. */
export function filterListing(result: DataExplorerResult, options: DataExplorerProviderOptions, query: string): DataExplorerResult {
    const allowed = options.allowedObjects;
    if (!allowed?.length || (options.language !== DataExplorerLanguage.Shell && options.language !== DataExplorerLanguage.Json) || !/^show\s+collections/i.test(query.trim())) {
        return result;
    }
    result.rows = (result.rows as Record<string, unknown>[]).filter(
        (r) => typeof r?.name === 'string' && isObjectAllowed(r.name, allowed),
    );
    result.rowCount = result.rows.length;
    return result;
}

// ── Rate limit ──────────────────────────────────────────────────────

/** Source and caller pairs kept at most before the ones whose window has passed are dropped. */
const MAX_TRACKED_CALLERS = 10_000;

/** Sliding-window counter of executes per source and caller. */
export class DataExplorerRateLimiter {
    private readonly hits = new Map<string, { times: number[]; windowMs: number }>();

    constructor(private readonly now: () => number = Date.now) {}

    /** Records an execute; false when the caller is over the source's limit (not recorded then). */
    tryAcquire(options: DataExplorerProviderOptions, caller: DataExplorerCaller | undefined): boolean {
        const limit = options.rateLimit;
        if (!limit || limit.maxQueries <= 0 || limit.windowSeconds <= 0) return true;
        const key = `${options.name}\u0000${caller?.userId ?? caller?.remoteAddress ?? 'anonymous'}`;
        const now = this.now();
        const windowMs = limit.windowSeconds * 1000;
        const recent = (this.hits.get(key)?.times ?? []).filter((t) => t > now - windowMs);
        if (recent.length >= limit.maxQueries) {
            this.hits.set(key, { times: recent, windowMs });
            return false;
        }
        recent.push(now);
        this.hits.set(key, { times: recent, windowMs });
        if (this.hits.size > MAX_TRACKED_CALLERS) this.sweep(now);
        return true;
    }

    /** Drops the callers whose last query is out of the window (remote addresses seen once). */
    private sweep(now: number): void {
        for (const [key, { times, windowMs }] of this.hits) {
            if (times[times.length - 1] <= now - windowMs) this.hits.delete(key);
        }
    }
}
