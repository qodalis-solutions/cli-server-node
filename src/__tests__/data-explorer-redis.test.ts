import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock ioredis before importing the provider (dynamic import inside provider)
// ---------------------------------------------------------------------------

const mockCall = vi.fn();
const mockDisconnect = vi.fn();
const mockScan = vi.fn();
const mockPipelineExec = vi.fn();
const mockPipeline = vi.fn(() => ({
    type: vi.fn().mockReturnThis(),
    exec: mockPipelineExec,
}));

const MockRedis = vi.fn(function (this: any) {
    this.call = mockCall;
    this.disconnect = mockDisconnect;
    this.scan = mockScan;
    this.pipeline = mockPipeline;
});

vi.mock('ioredis', () => ({
    default: MockRedis,
}));

import { RedisDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-redis';
import type { DataExplorerExecutionContext } from '@qodalis/cli-server-abstractions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(query: string): DataExplorerExecutionContext {
    return {
        query,
        options: {
            name: 'test-redis',
            language: 'redis',
            defaultOutputFormat: 'table',
        },
    } as DataExplorerExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisDataExplorerProvider', () => {
    let provider: RedisDataExplorerProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new RedisDataExplorerProvider({ connectionString: 'redis://localhost:6379' });
    });

    // -----------------------------------------------------------------------
    // Instantiation
    // -----------------------------------------------------------------------

    it('should be instantiable with a connection string', () => {
        expect(provider).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // Empty / whitespace command
    // -----------------------------------------------------------------------

    it('should return error result for empty query', async () => {
        const result = await provider.executeAsync(makeContext(''));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/empty command/i);
        expect(result.rows).toEqual([]);
        expect(mockCall).not.toHaveBeenCalled();
    });

    it('should return error result for whitespace-only query', async () => {
        const result = await provider.executeAsync(makeContext('   '));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/empty command/i);
    });

    // -----------------------------------------------------------------------
    // Blocked commands
    // -----------------------------------------------------------------------

    it('should reject disallowed commands', async () => {
        const result = await provider.executeAsync(makeContext('SHUTDOWN NOSAVE'));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not allowed/i);
        expect(mockCall).not.toHaveBeenCalled();
    });

    it('should reject CONFIG command', async () => {
        const result = await provider.executeAsync(makeContext('CONFIG SET maxmemory 100mb'));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not allowed/i);
    });

    // -----------------------------------------------------------------------
    // Command parsing: quotes and whitespace
    // -----------------------------------------------------------------------

    it('should parse a simple command without arguments', async () => {
        mockCall.mockResolvedValueOnce('PONG');

        const result = await provider.executeAsync(makeContext('PING'));

        expect(result.success).toBe(true);
        expect(mockCall).toHaveBeenCalledWith('PING');
        expect(result.columns).toEqual(['property', 'value']);
        expect(result.rows).toEqual([['response', 'PONG']]);
    });

    it('should parse a command with space-separated arguments', async () => {
        mockCall.mockResolvedValueOnce('hello');

        const result = await provider.executeAsync(makeContext('GET mykey'));

        expect(result.success).toBe(true);
        expect(mockCall).toHaveBeenCalledWith('GET', 'mykey');
        expect(result.rows[0]).toEqual(['mykey', 'hello']);
    });

    it('should parse arguments with double-quoted strings', async () => {
        mockCall.mockResolvedValueOnce('OK');

        await provider.executeAsync(makeContext('SET "my key" "hello world"'));

        expect(mockCall).toHaveBeenCalledWith('SET', 'my key', 'hello world');
    });

    it('should parse arguments with single-quoted strings', async () => {
        mockCall.mockResolvedValueOnce('OK');

        await provider.executeAsync(makeContext("SET 'spaced key' 'my value'"));

        expect(mockCall).toHaveBeenCalledWith('SET', 'spaced key', 'my value');
    });

    it('should treat command name case-insensitively', async () => {
        mockCall.mockResolvedValueOnce('PONG');

        const result = await provider.executeAsync(makeContext('ping'));

        expect(result.success).toBe(true);
        expect(mockCall).toHaveBeenCalledWith('PING');
    });

    // -----------------------------------------------------------------------
    // normalizeResult: PING
    // -----------------------------------------------------------------------

    it('should normalise PING response to property/value columns', async () => {
        mockCall.mockResolvedValueOnce('PONG');

        const result = await provider.executeAsync(makeContext('PING'));

        expect(result.columns).toEqual(['property', 'value']);
        expect(result.rows).toEqual([['response', 'PONG']]);
        expect(result.rowCount).toBe(1);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: DBSIZE
    // -----------------------------------------------------------------------

    it('should normalise DBSIZE response', async () => {
        mockCall.mockResolvedValueOnce(42);

        const result = await provider.executeAsync(makeContext('DBSIZE'));

        expect(result.columns).toEqual(['property', 'value']);
        expect(result.rows).toEqual([['dbsize', 42]]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: KEYS
    // -----------------------------------------------------------------------

    it('should normalise KEYS response to single key column', async () => {
        mockCall.mockResolvedValueOnce(['foo', 'bar', 'baz']);

        const result = await provider.executeAsync(makeContext('KEYS *'));

        expect(result.columns).toEqual(['key']);
        expect(result.rows).toEqual([['foo'], ['bar'], ['baz']]);
        expect(result.rowCount).toBe(3);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: HGETALL (object form)
    // -----------------------------------------------------------------------

    it('should normalise HGETALL response from object to field/value rows', async () => {
        mockCall.mockResolvedValueOnce({ name: 'Alice', age: '30' });

        const result = await provider.executeAsync(makeContext('HGETALL user:1'));

        expect(result.columns).toEqual(['field', 'value']);
        expect(result.rows).toContainEqual(['name', 'Alice']);
        expect(result.rows).toContainEqual(['age', '30']);
    });

    it('should normalise HGETALL response from flat array to field/value rows', async () => {
        mockCall.mockResolvedValueOnce(['name', 'Bob', 'age', '25']);

        const result = await provider.executeAsync(makeContext('HGETALL user:2'));

        expect(result.columns).toEqual(['field', 'value']);
        expect(result.rows).toEqual([
            ['name', 'Bob'],
            ['age', '25'],
        ]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: HKEYS
    // -----------------------------------------------------------------------

    it('should normalise HKEYS response', async () => {
        mockCall.mockResolvedValueOnce(['field1', 'field2']);

        const result = await provider.executeAsync(makeContext('HKEYS myhash'));

        expect(result.columns).toEqual(['field']);
        expect(result.rows).toEqual([['field1'], ['field2']]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: HVALS
    // -----------------------------------------------------------------------

    it('should normalise HVALS response', async () => {
        mockCall.mockResolvedValueOnce(['val1', 'val2']);

        const result = await provider.executeAsync(makeContext('HVALS myhash'));

        expect(result.columns).toEqual(['value']);
        expect(result.rows).toEqual([['val1'], ['val2']]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: LRANGE
    // -----------------------------------------------------------------------

    it('should normalise LRANGE response with index', async () => {
        mockCall.mockResolvedValueOnce(['a', 'b', 'c']);

        const result = await provider.executeAsync(makeContext('LRANGE mylist 0 -1'));

        expect(result.columns).toEqual(['index', 'value']);
        expect(result.rows).toEqual([
            [0, 'a'],
            [1, 'b'],
            [2, 'c'],
        ]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: LLEN
    // -----------------------------------------------------------------------

    it('should normalise LLEN response', async () => {
        mockCall.mockResolvedValueOnce(5);

        const result = await provider.executeAsync(makeContext('LLEN mylist'));

        expect(result.columns).toEqual(['key', 'value']);
        expect(result.rows).toEqual([['mylist', 5]]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: SMEMBERS
    // -----------------------------------------------------------------------

    it('should normalise SMEMBERS response to member column', async () => {
        mockCall.mockResolvedValueOnce(['alpha', 'beta']);

        const result = await provider.executeAsync(makeContext('SMEMBERS myset'));

        expect(result.columns).toEqual(['member']);
        expect(result.rows).toEqual([['alpha'], ['beta']]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: SCAN
    // -----------------------------------------------------------------------

    it('should normalise SCAN response with cursor and keys', async () => {
        mockCall.mockResolvedValueOnce(['17', ['key1', 'key2']]);

        const result = await provider.executeAsync(makeContext('SCAN 0'));

        expect(result.columns).toEqual(['cursor', 'key']);
        expect(result.rows[0]).toEqual(['17', '']);    // cursor row
        expect(result.rows[1]).toEqual(['', 'key1']);
        expect(result.rows[2]).toEqual(['', 'key2']);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: MGET
    // -----------------------------------------------------------------------

    it('should normalise MGET response mapping keys to values', async () => {
        mockCall.mockResolvedValueOnce(['val1', null, 'val3']);

        const result = await provider.executeAsync(makeContext('MGET k1 k2 k3'));

        expect(result.columns).toEqual(['key', 'value']);
        expect(result.rows).toEqual([
            ['k1', 'val1'],
            ['k2', null],
            ['k3', 'val3'],
        ]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: TTL / PTTL / EXISTS / EXPIRE
    // -----------------------------------------------------------------------

    it('should normalise TTL response', async () => {
        mockCall.mockResolvedValueOnce(120);

        const result = await provider.executeAsync(makeContext('TTL mykey'));

        expect(result.columns).toEqual(['key', 'value']);
        expect(result.rows).toEqual([['mykey', 120]]);
    });

    it('should normalise EXISTS response', async () => {
        mockCall.mockResolvedValueOnce(1);

        const result = await provider.executeAsync(makeContext('EXISTS mykey'));

        expect(result.columns).toEqual(['key', 'value']);
        expect(result.rows).toEqual([['mykey', 1]]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: HGET
    // -----------------------------------------------------------------------

    it('should normalise HGET response using field name as key', async () => {
        mockCall.mockResolvedValueOnce('Alice');

        const result = await provider.executeAsync(makeContext('HGET user:1 name'));

        expect(result.columns).toEqual(['key', 'value']);
        expect(result.rows).toEqual([['name', 'Alice']]);
    });

    // -----------------------------------------------------------------------
    // normalizeResult: INFO
    // -----------------------------------------------------------------------

    it('should normalise INFO response by parsing key:value lines', async () => {
        const infoOutput = `# Server\r\nredis_version:7.0.0\r\nredis_mode:standalone\r\n\r\n# Clients\r\nconnected_clients:1\r\n`;
        mockCall.mockResolvedValueOnce(infoOutput);

        const result = await provider.executeAsync(makeContext('INFO'));

        expect(result.columns).toEqual(['property', 'value']);
        expect(result.rows).toContainEqual(['redis_version', '7.0.0']);
        expect(result.rows).toContainEqual(['redis_mode', 'standalone']);
        expect(result.rows).toContainEqual(['connected_clients', '1']);
        // section headers (# Server) should be skipped
        expect(result.rows.map((r) => r[0])).not.toContain('# Server');
    });

    // -----------------------------------------------------------------------
    // Disconnect is always called
    // -----------------------------------------------------------------------

    it('should disconnect after a successful command', async () => {
        mockCall.mockResolvedValueOnce('OK');

        await provider.executeAsync(makeContext('PING'));

        expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it('should disconnect even when the command throws', async () => {
        mockCall.mockRejectedValueOnce(new Error('Connection refused'));

        const result = await provider.executeAsync(makeContext('PING'));

        expect(result.success).toBe(false);
        expect(result.error).toBe('Connection refused');
        expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    // -----------------------------------------------------------------------
    // Result metadata
    // -----------------------------------------------------------------------

    it('should populate source, language, defaultOutputFormat, and rowCount', async () => {
        mockCall.mockResolvedValueOnce(['k1', 'k2']);

        const result = await provider.executeAsync(makeContext('KEYS *'));

        expect(result.source).toBe('test-redis');
        expect(result.language).toBe('redis');
        expect(result.defaultOutputFormat).toBe('table');
        expect(result.rowCount).toBe(2);
        expect(result.truncated).toBe(false);
        expect(typeof result.executionTime).toBe('number');
    });
});
