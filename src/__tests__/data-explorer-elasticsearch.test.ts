import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @elastic/elasticsearch before importing the provider.
// vi.hoisted() is used so the mock variable is available inside the hoisted
// vi.mock() factory call.
// ---------------------------------------------------------------------------

const { mockRequest, MockClient } = vi.hoisted(() => {
    const mockRequest = vi.fn();
    const MockClient = vi.fn(function (this: any) {
        this.transport = { request: mockRequest };
    });
    return { mockRequest, MockClient };
});

vi.mock('@elastic/elasticsearch', () => ({
    Client: MockClient,
}));

import { ElasticsearchDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-elasticsearch';
import type { DataExplorerExecutionContext, DataExplorerProviderOptions } from '@qodalis/cli-server-abstractions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(query: string): DataExplorerExecutionContext {
    return {
        query,
        options: {
            name: 'test-es',
            language: 'elasticsearch',
            defaultOutputFormat: 'table',
        },
    } as DataExplorerExecutionContext;
}

function makeProviderOptions(): DataExplorerProviderOptions {
    return { name: 'test-es' } as DataExplorerProviderOptions;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ElasticsearchDataExplorerProvider', () => {
    let provider: ElasticsearchDataExplorerProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new ElasticsearchDataExplorerProvider({ node: 'http://localhost:9200' });
    });

    // -----------------------------------------------------------------------
    // Instantiation
    // -----------------------------------------------------------------------

    it('should be instantiable with a node URL', () => {
        expect(provider).toBeDefined();
    });

    it('should construct the ES Client with the provided node URL', () => {
        expect(MockClient).toHaveBeenCalledWith({ node: 'http://localhost:9200' });
    });

    // -----------------------------------------------------------------------
    // Query parsing — verb + path format
    // -----------------------------------------------------------------------

    it('should parse "GET /path" and send a GET request', async () => {
        mockRequest.mockResolvedValueOnce({ response: 'ok' });

        await provider.executeAsync(makeContext('GET /_cluster/health'));

        expect(mockRequest).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'GET', path: '/_cluster/health' }),
        );
    });

    it('should parse "POST /path" and send a POST request with body', async () => {
        mockRequest.mockResolvedValueOnce({ hits: { hits: [] } });
        const query = 'POST /my-index/_search\n{"query":{"match_all":{}}}';

        await provider.executeAsync(makeContext(query));

        const callArg = mockRequest.mock.calls[0][0];
        expect(callArg.method).toBe('POST');
        expect(callArg.path).toBe('/my-index/_search');
        expect(callArg.body).toEqual({ query: { match_all: {} } });
    });

    it('should normalise method to uppercase', async () => {
        mockRequest.mockResolvedValueOnce({ response: 'ok' });

        await provider.executeAsync(makeContext('get /_cat/indices'));

        expect(mockRequest.mock.calls[0][0].method).toBe('GET');
    });

    it('should prepend "/" to path when missing', async () => {
        mockRequest.mockResolvedValueOnce({ response: 'ok' });

        await provider.executeAsync(makeContext('GET _cluster/health'));

        expect(mockRequest.mock.calls[0][0].path).toBe('/_cluster/health');
    });

    // -----------------------------------------------------------------------
    // Query parsing — bare path shortcut
    // -----------------------------------------------------------------------

    it('should treat bare path starting with "/" as GET request', async () => {
        mockRequest.mockResolvedValueOnce({ response: 'ok' });

        await provider.executeAsync(makeContext('/_cluster/health'));

        expect(mockRequest.mock.calls[0][0].method).toBe('GET');
        expect(mockRequest.mock.calls[0][0].path).toBe('/_cluster/health');
    });

    it('should treat bare path starting with "_" as GET request', async () => {
        mockRequest.mockResolvedValueOnce({ response: 'ok' });

        await provider.executeAsync(makeContext('_cluster/health'));

        expect(mockRequest.mock.calls[0][0].method).toBe('GET');
        expect(mockRequest.mock.calls[0][0].path).toBe('/_cluster/health');
    });

    // -----------------------------------------------------------------------
    // Query parsing — invalid format
    // -----------------------------------------------------------------------

    it('should return error result for invalid query format', async () => {
        const result = await provider.executeAsync(makeContext('INVALID_FORMAT_NO_SPACE'));

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/invalid query format/i);
        expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should return error for unsupported HTTP method', async () => {
        const result = await provider.executeAsync(makeContext('PATCH /my-index'));

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/unsupported http method/i);
        expect(mockRequest).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // _cat endpoints: force JSON format
    // -----------------------------------------------------------------------

    it('should add format=json querystring for _cat endpoints', async () => {
        mockRequest.mockResolvedValueOnce([{ index: 'my-index', health: 'green', status: 'open' }]);

        await provider.executeAsync(makeContext('GET /_cat/indices'));

        const callArg = mockRequest.mock.calls[0][0];
        expect(callArg.querystring).toEqual({ format: 'json' });
    });

    it('should return _cat response as rows with column headers from first record', async () => {
        mockRequest.mockResolvedValueOnce([
            { index: 'logs-2025', health: 'green', status: 'open' },
            { index: 'metrics-2025', health: 'yellow', status: 'open' },
        ]);

        const result = await provider.executeAsync(makeContext('GET /_cat/indices'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['index', 'health', 'status']);
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toEqual(['logs-2025', 'green', 'open']);
        expect(result.rows[1]).toEqual(['metrics-2025', 'yellow', 'open']);
    });

    it('should return empty result for empty _cat response', async () => {
        mockRequest.mockResolvedValueOnce([]);

        const result = await provider.executeAsync(makeContext('GET /_cat/indices'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual([]);
        expect(result.rows).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // _search response normalisation
    // -----------------------------------------------------------------------

    it('should flatten _search hits into rows with _id and source fields', async () => {
        mockRequest.mockResolvedValueOnce({
            hits: {
                hits: [
                    { _id: 'doc1', _source: { title: 'Hello', author: 'Alice' } },
                    { _id: 'doc2', _source: { title: 'World', author: 'Bob' } },
                ],
            },
        });

        const result = await provider.executeAsync(makeContext('GET /my-index/_search'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['_id', 'title', 'author']);
        expect(result.rows[0]).toEqual(['doc1', 'Hello', 'Alice']);
        expect(result.rows[1]).toEqual(['doc2', 'World', 'Bob']);
        expect(result.rowCount).toBe(2);
    });

    it('should merge unique columns from all hits in _search response', async () => {
        mockRequest.mockResolvedValueOnce({
            hits: {
                hits: [
                    { _id: 'doc1', _source: { field_a: 'a1' } },
                    { _id: 'doc2', _source: { field_a: 'a2', field_b: 'b2' } },
                ],
            },
        });

        const result = await provider.executeAsync(makeContext('GET /my-index/_search'));

        expect(result.columns).toContain('_id');
        expect(result.columns).toContain('field_a');
        expect(result.columns).toContain('field_b');
        expect(result.rows[0]).toHaveLength(3); // _id, field_a, field_b (field_b => undefined)
    });

    it('should return empty rows for _search with no hits', async () => {
        mockRequest.mockResolvedValueOnce({ hits: { hits: [] } });

        const result = await provider.executeAsync(makeContext('GET /my-index/_search'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['_id']);
        expect(result.rows).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Generic response normalisation
    // -----------------------------------------------------------------------

    it('should wrap generic responses in a single-column "response" result', async () => {
        const payload = { cluster_name: 'my-cluster', status: 'green' };
        mockRequest.mockResolvedValueOnce(payload);

        const result = await provider.executeAsync(makeContext('GET /_cluster/health'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['response']);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0][0]).toBe(JSON.stringify(payload, null, 2));
    });

    // -----------------------------------------------------------------------
    // Error handling
    // -----------------------------------------------------------------------

    it('should return error result when transport.request throws', async () => {
        mockRequest.mockRejectedValueOnce(new Error('connection timeout'));

        const result = await provider.executeAsync(makeContext('GET /_cluster/health'));

        expect(result.success).toBe(false);
        expect(result.error).toBe('connection timeout');
        expect(result.rows).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Result metadata
    // -----------------------------------------------------------------------

    it('should populate source, language, defaultOutputFormat, and rowCount', async () => {
        mockRequest.mockResolvedValueOnce({ response: 'ok' });

        const result = await provider.executeAsync(makeContext('GET /_cluster/health'));

        expect(result.source).toBe('test-es');
        expect(result.language).toBe('elasticsearch');
        expect(result.defaultOutputFormat).toBe('table');
        expect(result.truncated).toBe(false);
        expect(typeof result.executionTime).toBe('number');
    });

    // -----------------------------------------------------------------------
    // getSchemaAsync
    // -----------------------------------------------------------------------

    it('should return schema with index tables (skipping hidden indices starting with ".")', async () => {
        // First call: _cat/indices
        mockRequest.mockResolvedValueOnce([
            { index: 'products' },
            { index: '.kibana' },   // hidden — should be skipped
            { index: 'orders' },
        ]);

        // Mapping for 'products'
        mockRequest.mockResolvedValueOnce({
            products: {
                mappings: {
                    properties: {
                        name: { type: 'keyword' },
                        price: { type: 'float' },
                    },
                },
            },
        });

        // Mapping for 'orders'
        mockRequest.mockResolvedValueOnce({
            orders: {
                mappings: {
                    properties: {
                        order_id: { type: 'integer' },
                    },
                },
            },
        });

        const schema = await provider.getSchemaAsync(makeProviderOptions());

        expect(schema.source).toBe('test-es');
        expect(schema.tables).toHaveLength(2);

        const productTable = schema.tables.find((t) => t.name === 'products')!;
        expect(productTable.type).toBe('index');
        const colNames = productTable.columns.map((c) => c.name);
        expect(colNames).toContain('_id');
        expect(colNames).toContain('name');
        expect(colNames).toContain('price');

        const idCol = productTable.columns.find((c) => c.name === '_id')!;
        expect(idCol.primaryKey).toBe(true);
        expect(idCol.nullable).toBe(false);
    });

    it('should flatten nested mapping properties using dot notation', async () => {
        mockRequest.mockResolvedValueOnce([{ index: 'events' }]);

        mockRequest.mockResolvedValueOnce({
            events: {
                mappings: {
                    properties: {
                        user: {
                            properties: {
                                name: { type: 'keyword' },
                                email: { type: 'keyword' },
                            },
                        },
                        timestamp: { type: 'date' },
                    },
                },
            },
        });

        const schema = await provider.getSchemaAsync(makeProviderOptions());
        const colNames = schema.tables[0].columns.map((c) => c.name);

        expect(colNames).toContain('user.name');
        expect(colNames).toContain('user.email');
        expect(colNames).toContain('timestamp');
    });

    it('should handle failed mapping fetch gracefully with _id-only columns', async () => {
        mockRequest.mockResolvedValueOnce([{ index: 'broken-index' }]);
        mockRequest.mockRejectedValueOnce(new Error('mapping not found'));

        const schema = await provider.getSchemaAsync(makeProviderOptions());

        expect(schema.tables).toHaveLength(1);
        const cols = schema.tables[0].columns;
        expect(cols).toHaveLength(1);
        expect(cols[0].name).toBe('_id');
    });
});
