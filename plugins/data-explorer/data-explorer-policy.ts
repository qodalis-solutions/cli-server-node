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

/** How a dialect reads strings: MySQL takes `\'` as an escape, Postgres `$tag$` quotes; SQL Server and SQLite neither. */
export interface SqlReading {
    backslashEscapes: boolean;
    dollarQuotes: boolean;
}

/** Both readings: a query is checked under each, so a dialect-specific quote cannot hide a statement. */
const SQL_READINGS: SqlReading[] = [
    { backslashEscapes: true, dollarQuotes: true },
    { backslashEscapes: false, dollarQuotes: false },
];

/**
 * Splits SQL into words, quoted identifiers and punctuation; comments and string literals
 * are dropped, so keywords inside them do not count.
 */
export function tokenizeSql(sql: string, reading: SqlReading = SQL_READINGS[0]): SqlToken[] {
    const tokens: SqlToken[] = [];
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        const next = sql[i + 1];
        if (c === '-' && next === '-') {
            while (i < sql.length && sql[i] !== '\n') i++;
            continue;
        }
        if (c === '#' && (next === undefined || /\s/.test(next))) {
            // MySQL comment (`#t` is a SQL Server temp table)
            while (i < sql.length && sql[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && next === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? sql.length : end + 2;
            continue;
        }
        if (c === "'") {
            i++;
            while (i < sql.length) {
                if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
                else if (reading.backslashEscapes && sql[i] === '\\') i += 2;
                else if (sql[i] === "'") break;
                else i++;
            }
            i++;
            continue;
        }
        if (c === '$' && reading.dollarQuotes) {
            // Postgres dollar-quoted string: $tag$ ... $tag$
            const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
            if (m) {
                const end = sql.indexOf(m[0], i + m[0].length);
                i = end < 0 ? sql.length : end + m[0].length;
                continue;
            }
        }
        if (c === '"' || c === '`' || c === '[') {
            const close = c === '[' ? ']' : c;
            const end = sql.indexOf(close, i + 1);
            const name = sql.slice(i + 1, end < 0 ? sql.length : end);
            tokens.push({ kind: 'ident', value: name, raw: name });
            i = end < 0 ? sql.length : end + 1;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
            const raw = sql.slice(i, j);
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
    'REVOKE', 'COPY', 'CALL', 'EXEC', 'EXECUTE', 'INTO', 'LOCK', 'VACUUM', 'ATTACH', 'DETACH', 'PRAGMA', 'SET',
]);
/** Write keywords that are also read-only functions when a `(` follows (`REPLACE(name, 'a', 'b')`). */
const SQL_FUNCTION_WORDS = new Set(['REPLACE', 'INSERT']);

function sqlReadOnlyError(query: string): string | undefined {
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

/** The tables a SQL query names (after FROM, JOIN, INTO, UPDATE, TABLE), without the CTE names it defines. */
export function sqlObjects(query: string): string[] {
    const all = new Set<string>();
    for (const reading of SQL_READINGS) for (const o of sqlObjectsAs(query, reading)) all.add(o);
    return [...all];
}

function sqlObjectsAs(query: string, reading: SqlReading): string[] {
    const tokens = tokenizeSql(query, reading);
    const isName = (t: SqlToken | undefined) => !!t && (t.kind === 'ident' || t.kind === 'word');
    // CTE names: name [ (columns) ] AS (
    const cteNames = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
        if (!isName(tokens[i])) continue;
        let j = i + 1;
        if (tokens[j]?.value === '(') {
            let depth = 0;
            for (; j < tokens.length; j++) {
                if (tokens[j].value === '(') depth++;
                else if (tokens[j].value === ')' && --depth === 0) break;
            }
            j++;
        }
        if (tokens[j]?.value === 'AS' && tokens[j + 1]?.value === '(') cteNames.add(tokens[i].raw.toLowerCase());
    }

    const objects: string[] = [];
    const openers: (string | undefined)[] = [];
    const readName = (start: number): [string, number] | undefined => {
        if (!isName(tokens[start])) return undefined;
        const parts = [tokens[start].raw];
        let k = start + 1;
        while (tokens[k]?.value === '.' && isName(tokens[k + 1])) {
            parts.push(tokens[k + 1].raw);
            k += 2;
        }
        return [parts.join('.'), k];
    };
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.value === '(') {
            openers.push(tokens[i - 1]?.kind === 'word' ? tokens[i - 1].value : undefined);
            continue;
        }
        if (t.value === ')') {
            openers.pop();
            continue;
        }
        if (t.kind !== 'word' || !SQL_OBJECT_KEYWORDS.has(t.value)) continue;
        if (t.value === 'FROM' && SQL_FROM_FUNCTIONS.has(openers[openers.length - 1] ?? '')) continue;
        let k = i + 1;
        // FROM a, b, c
        for (;;) {
            if (tokens[k]?.value === 'ONLY' || tokens[k]?.value === 'LATERAL') k++;
            const name = readName(k);
            if (!name) break;
            if (!cteNames.has(name[0].toLowerCase())) objects.push(name[0]);
            k = name[1];
            // An alias: [AS] alias
            if (tokens[k]?.value === 'AS') k += 2;
            else if (tokens[k]?.kind === 'word' && !isClauseWord(tokens[k].value)) k++;
            if (tokens[k]?.value !== ',' || t.value !== 'FROM') break;
            k++;
        }
    }
    return objects;
}

function isClauseWord(word: string): boolean {
    return [
        'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING',
        'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FETCH', 'FOR', 'NATURAL', 'SET', 'VALUES',
        'SELECT', 'RETURNING', 'TABLESAMPLE', 'WITH',
    ].includes(word);
}

// ── MongoDB ─────────────────────────────────────────────────────────

const MONGO_READ_METHODS = new Set(['find', 'findone', 'countdocuments', 'estimateddocumentcount', 'distinct', 'aggregate']);
const MONGO_SHOW = /^show\s+(collections|dbs|databases)\s*;?$/i;
const MONGO_CALL = /^db\.(?:getCollection\(\s*['"]([^'"]+)['"]\s*\)|([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*?))\.(\w+)\s*\(/;

function mongoReadOnlyError(query: string): string | undefined {
    const q = query.trim();
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

function mongoObjects(query: string): string[] | undefined {
    const q = query.trim();
    if (MONGO_SHOW.test(q)) return [];
    const m = MONGO_CALL.exec(q);
    return m ? [m[1] ?? m[2]] : undefined;
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

function redisWords(query: string): string[] {
    return (query.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
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

const ES_READ_POST = /\/(_search|_count|_msearch|_mget|_field_caps|_validate\/query)$/;

function esRequestLine(query: string): { verb: string; path: string } {
    const first = query.trim().split('\n')[0].trim();
    const m = /^(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S+)/i.exec(first);
    if (m) return { verb: m[1].toUpperCase(), path: m[2].startsWith('/') ? m[2] : `/${m[2]}` };
    return { verb: 'GET', path: first.startsWith('/') ? first : `/${first}` };
}

function esReadOnlyError(query: string): string | undefined {
    const { verb, path } = esRequestLine(query);
    if (verb === 'GET' || verb === 'HEAD') return undefined;
    if (verb === 'POST' && ES_READ_POST.test(path.split('?')[0])) return undefined;
    return `Read-only source: ${verb} ${path.split('?')[0]} is not allowed`;
}

function esObjects(query: string): string[] | undefined {
    const { path } = esRequestLine(query);
    const first = path.split('?')[0].split('/').filter(Boolean)[0];
    if (!first || first.startsWith('_')) return undefined;
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
            return sqlObjects(query);
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
    if (Array.isArray(value)) return value.map((v) => maskObject(v, mask, drop));
    if (value === null || typeof value !== 'object' || value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (matchesAny(key, drop)) continue;
        out[key] = matchesAny(key, mask) ? (v === null || v === undefined ? v : MASK) : maskObject(v, mask, drop);
    }
    return out;
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

/** Sliding-window counter of executes per source and caller. */
export class DataExplorerRateLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(private readonly now: () => number = Date.now) {}

    /** Records an execute; false when the caller is over the source's limit (not recorded then). */
    tryAcquire(options: DataExplorerProviderOptions, caller: DataExplorerCaller | undefined): boolean {
        const limit = options.rateLimit;
        if (!limit || limit.maxQueries <= 0 || limit.windowSeconds <= 0) return true;
        const key = `${options.name}\u0000${caller?.userId ?? caller?.remoteAddress ?? 'anonymous'}`;
        const now = this.now();
        const since = now - limit.windowSeconds * 1000;
        const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
        if (recent.length >= limit.maxQueries) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(now);
        this.hits.set(key, recent);
        return true;
    }
}
