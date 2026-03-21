import {
    IDataExplorerProvider,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerSchemaResult,
    DataExplorerSchemaTable,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';

export interface RedisConnectionOptions {
    connectionString: string;
}

const ALLOWED_COMMANDS = new Set([
    'GET', 'SET', 'DEL', 'KEYS', 'HGET', 'HSET', 'HGETALL', 'HDEL', 'HKEYS', 'HVALS',
    'LPUSH', 'RPUSH', 'LRANGE', 'LLEN', 'SADD', 'SMEMBERS', 'SCARD',
    'ZADD', 'ZRANGE', 'ZRANGEBYSCORE', 'INCR', 'DECR', 'EXPIRE', 'TTL', 'PTTL',
    'EXISTS', 'TYPE', 'MGET', 'MSET', 'SCAN', 'INFO', 'DBSIZE', 'PING', 'FLUSHDB',
]);

function parseCommandArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote: string | null = null;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inQuote) {
            if (ch === inQuote) {
                inQuote = null;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (ch === ' ' || ch === '\t') {
            if (current.length > 0) {
                args.push(current);
                current = '';
            }
        } else {
            current += ch;
        }
    }

    if (current.length > 0) {
        args.push(current);
    }

    return args;
}

function normalizeResult(
    command: string,
    args: string[],
    result: unknown,
): { columns: string[]; rows: unknown[][] } {
    const cmd = command.toUpperCase();

    if (cmd === 'PING') {
        return {
            columns: ['property', 'value'],
            rows: [['response', result]],
        };
    }

    if (cmd === 'DBSIZE') {
        return {
            columns: ['property', 'value'],
            rows: [['dbsize', result]],
        };
    }

    if (cmd === 'INFO') {
        const rows: unknown[][] = [];
        if (typeof result === 'string') {
            for (const line of result.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const colonIdx = trimmed.indexOf(':');
                if (colonIdx === -1) continue;
                const key = trimmed.substring(0, colonIdx).trim();
                const val = trimmed.substring(colonIdx + 1).trim();
                rows.push([key, val]);
            }
        }
        return { columns: ['property', 'value'], rows };
    }

    if (cmd === 'HGETALL') {
        const rows: unknown[][] = [];
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            for (const [field, value] of Object.entries(result as Record<string, string>)) {
                rows.push([field, value]);
            }
        } else if (Array.isArray(result)) {
            for (let i = 0; i + 1 < result.length; i += 2) {
                rows.push([result[i], result[i + 1]]);
            }
        }
        return { columns: ['field', 'value'], rows };
    }

    if (cmd === 'HKEYS') {
        const arr = Array.isArray(result) ? result : [];
        return { columns: ['field'], rows: arr.map((f) => [f]) };
    }

    if (cmd === 'HVALS') {
        const arr = Array.isArray(result) ? result : [];
        return { columns: ['value'], rows: arr.map((v) => [v]) };
    }

    if (cmd === 'LRANGE') {
        const arr = Array.isArray(result) ? result : [];
        return { columns: ['index', 'value'], rows: arr.map((v, i) => [i, v]) };
    }

    if (cmd === 'LLEN' || cmd === 'SCARD') {
        return { columns: ['key', 'value'], rows: [[args[0] ?? '', result]] };
    }

    if (cmd === 'SMEMBERS') {
        const arr = Array.isArray(result) ? result : [];
        return { columns: ['member'], rows: arr.map((m) => [m]) };
    }

    if (cmd === 'ZRANGE' || cmd === 'ZRANGEBYSCORE') {
        const arr = Array.isArray(result) ? result : [];
        return { columns: ['member'], rows: arr.map((m) => [m]) };
    }

    if (cmd === 'KEYS') {
        const arr = Array.isArray(result) ? result : [];
        return { columns: ['key'], rows: arr.map((k) => [k]) };
    }

    if (cmd === 'SCAN') {
        const arr = Array.isArray(result) ? result : [];
        const cursor = arr[0] ?? '0';
        const keys = Array.isArray(arr[1]) ? arr[1] : [];
        const rows: unknown[][] = [[cursor, '']];
        for (const k of keys) {
            rows.push(['', k]);
        }
        return { columns: ['cursor', 'key'], rows };
    }

    if (cmd === 'MGET') {
        const arr = Array.isArray(result) ? result : [];
        return { columns: ['key', 'value'], rows: arr.map((v, i) => [args[i] ?? i, v]) };
    }

    if (['DEL', 'EXISTS', 'EXPIRE', 'TTL', 'PTTL', 'INCR', 'DECR', 'TYPE', 'HDEL'].includes(cmd)) {
        return { columns: ['key', 'value'], rows: [[args[0] ?? '', result]] };
    }

    if (cmd === 'HGET') {
        return { columns: ['key', 'value'], rows: [[args[1] ?? '', result]] };
    }

    return { columns: ['key', 'value'], rows: [[args[0] ?? '', result]] };
}

export class RedisDataExplorerProvider implements IDataExplorerProvider {
    private readonly connectionOptions: RedisConnectionOptions;

    constructor(connectionOptions: RedisConnectionOptions) {
        this.connectionOptions = connectionOptions;
    }

    async executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult> {
        const startTime = Date.now();
        const { default: Redis } = await import('ioredis');
        const redis = new Redis(this.connectionOptions.connectionString);

        try {
            const parts = parseCommandArgs(context.query.trim());
            if (parts.length === 0) {
                return {
                    success: false,
                    source: context.options.name,
                    language: context.options.language,
                    defaultOutputFormat: context.options.defaultOutputFormat,
                    executionTime: Date.now() - startTime,
                    columns: null,
                    rows: [],
                    rowCount: 0,
                    truncated: false,
                    error: 'Empty command',
                };
            }

            const command = parts[0].toUpperCase();
            const args = parts.slice(1);

            if (!ALLOWED_COMMANDS.has(command)) {
                return {
                    success: false,
                    source: context.options.name,
                    language: context.options.language,
                    defaultOutputFormat: context.options.defaultOutputFormat,
                    executionTime: Date.now() - startTime,
                    columns: null,
                    rows: [],
                    rowCount: 0,
                    truncated: false,
                    error: `Command '${command}' is not allowed. Allowed commands: ${[...ALLOWED_COMMANDS].join(', ')}`,
                };
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await (redis as any).call(command, ...args);
            const { columns, rows } = normalizeResult(command, args, result);

            return {
                success: true,
                source: context.options.name,
                language: context.options.language,
                defaultOutputFormat: context.options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
                columns,
                rows,
                rowCount: rows.length,
                truncated: false,
                error: null,
            };
        } catch (error) {
            return {
                success: false,
                source: context.options.name,
                language: context.options.language,
                defaultOutputFormat: context.options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
                columns: null,
                rows: [],
                rowCount: 0,
                truncated: false,
                error: error instanceof Error ? error.message : String(error),
            };
        } finally {
            redis.disconnect();
        }
    }

    async getSchemaAsync(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult> {
        const { default: Redis } = await import('ioredis');
        const redis = new Redis(this.connectionOptions.connectionString);

        try {
            const allKeys: string[] = [];
            let cursor = '0';
            let iterations = 0;
            const maxIterations = 10;

            do {
                const [nextCursor, keys] = await redis.scan(cursor, 'COUNT', 100);
                cursor = nextCursor;
                allKeys.push(...keys);
                iterations++;
            } while (cursor !== '0' && iterations < maxIterations);

            const typeMap: Map<string, string[]> = new Map();

            if (allKeys.length > 0) {
                const pipeline = redis.pipeline();
                for (const key of allKeys) {
                    pipeline.type(key);
                }
                const typeResults = await pipeline.exec();

                for (let i = 0; i < allKeys.length; i++) {
                    const typeResult = typeResults?.[i];
                    const keyType = (typeResult?.[1] as string) ?? 'string';
                    if (!typeMap.has(keyType)) {
                        typeMap.set(keyType, []);
                    }
                    typeMap.get(keyType)!.push(allKeys[i]);
                }
            }

            const columnSchemaByType: Record<string, { name: string }[]> = {
                string: [{ name: 'key' }, { name: 'value' }],
                hash: [{ name: 'key' }, { name: 'field' }, { name: 'value' }],
                list: [{ name: 'key' }, { name: 'index' }, { name: 'value' }],
                set: [{ name: 'key' }, { name: 'member' }],
                zset: [{ name: 'key' }, { name: 'member' }, { name: 'score' }],
            };

            const tables: DataExplorerSchemaTable[] = [];

            for (const [redisType, keys] of typeMap.entries()) {
                const schemaColumns = columnSchemaByType[redisType] ?? [{ name: 'key' }, { name: 'value' }];
                tables.push({
                    name: redisType,
                    type: redisType,
                    columns: schemaColumns.map((c) => ({
                        name: c.name,
                        type: 'string',
                        nullable: true,
                        primaryKey: c.name === 'key',
                    })),
                    rowCount: keys.length,
                } as DataExplorerSchemaTable);
            }

            return { source: options.name, tables };
        } finally {
            redis.disconnect();
        }
    }
}
