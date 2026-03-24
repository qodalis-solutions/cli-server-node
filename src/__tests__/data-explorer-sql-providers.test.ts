import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// All mock variables must be created with vi.hoisted() so they are available
// inside the hoisted vi.mock() factory calls.
// ---------------------------------------------------------------------------

const {
    mockPgConnect,
    mockPgQuery,
    mockPgEnd,
    mockMysqlExecute,
    mockMysqlEnd,
    mockMysqlConnection,
    mockMssqlQuery,
    mockMssqlPoolClose,
    mockPool,
    mockRequest,
} = vi.hoisted(() => {
    const mockPgConnect = vi.fn();
    const mockPgQuery = vi.fn();
    const mockPgEnd = vi.fn();

    const mockMysqlExecute = vi.fn();
    const mockMysqlEnd = vi.fn();
    const mockMysqlConnection = {
        execute: mockMysqlExecute,
        end: mockMysqlEnd,
    };

    const mockMssqlQuery = vi.fn();
    const mockMssqlPoolClose = vi.fn();
    const mockRequest = {
        query: mockMssqlQuery,
        input: vi.fn().mockReturnThis(),
    };
    const mockPool = {
        request: vi.fn().mockReturnValue(mockRequest),
        close: mockMssqlPoolClose,
    };

    return {
        mockPgConnect,
        mockPgQuery,
        mockPgEnd,
        mockMysqlExecute,
        mockMysqlEnd,
        mockMysqlConnection,
        mockMssqlQuery,
        mockMssqlPoolClose,
        mockPool,
        mockRequest,
    };
});

// ---------------------------------------------------------------------------
// Mock pg
// ---------------------------------------------------------------------------

vi.mock('pg', () => {
    const Client = vi.fn(function (this: any) {
        this.connect = mockPgConnect;
        this.query = mockPgQuery;
        this.end = mockPgEnd;
    });
    return { Client };
});

// ---------------------------------------------------------------------------
// Mock mysql2/promise
// ---------------------------------------------------------------------------

vi.mock('mysql2/promise', () => ({
    createConnection: vi.fn().mockResolvedValue(mockMysqlConnection),
}));

// ---------------------------------------------------------------------------
// Mock mssql
// ---------------------------------------------------------------------------

vi.mock('mssql', () => ({
    connect: vi.fn().mockResolvedValue(mockPool),
    NVarChar: 'NVarChar',
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PostgresDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-postgres';
import { MysqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-mysql';
import { MssqlDataExplorerProvider } from '@qodalis/cli-server-plugin-data-explorer-mssql';
import type { DataExplorerExecutionContext, DataExplorerProviderOptions } from '@qodalis/cli-server-abstractions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(query: string, name = 'test-db'): DataExplorerExecutionContext {
    return {
        query,
        options: {
            name,
            language: 'sql',
            defaultOutputFormat: 'table',
        },
    } as DataExplorerExecutionContext;
}

function makeProviderOptions(name = 'test-db'): DataExplorerProviderOptions {
    return { name } as DataExplorerProviderOptions;
}

// ===========================================================================
// PostgresDataExplorerProvider
// ===========================================================================

describe('PostgresDataExplorerProvider', () => {
    let provider: PostgresDataExplorerProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new PostgresDataExplorerProvider({
            connectionString: 'postgresql://demo:demo@localhost:5432/demo',
        });
        mockPgConnect.mockResolvedValue(undefined);
        mockPgEnd.mockResolvedValue(undefined);
    });

    // -----------------------------------------------------------------------
    // Instantiation
    // -----------------------------------------------------------------------

    it('should be instantiable', () => {
        expect(provider).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // executeAsync — happy path
    // -----------------------------------------------------------------------

    it('should execute a query and return tabular results', async () => {
        mockPgQuery.mockResolvedValueOnce({
            fields: [{ name: 'id' }, { name: 'name' }],
            rows: [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ],
        });

        const result = await provider.executeAsync(makeContext('SELECT id, name FROM users'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['id', 'name']);
        expect(result.rows).toEqual([
            [1, 'Alice'],
            [2, 'Bob'],
        ]);
        expect(result.rowCount).toBe(2);
        expect(result.truncated).toBe(false);
        expect(result.error).toBeNull();
    });

    it('should return empty rows when query returns no records', async () => {
        mockPgQuery.mockResolvedValueOnce({
            fields: [{ name: 'id' }, { name: 'name' }],
            rows: [],
        });

        const result = await provider.executeAsync(makeContext('SELECT * FROM empty_table'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['id', 'name']);
        expect(result.rows).toHaveLength(0);
        expect(result.rowCount).toBe(0);
    });

    // -----------------------------------------------------------------------
    // executeAsync — error handling
    // -----------------------------------------------------------------------

    it('should return error result when connection fails', async () => {
        mockPgConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const result = await provider.executeAsync(makeContext('SELECT 1'));

        expect(result.success).toBe(false);
        expect(result.error).toBe('ECONNREFUSED');
        expect(result.rows).toEqual([]);
        expect(result.columns).toBeNull();
    });

    it('should return error result when query fails', async () => {
        mockPgQuery.mockRejectedValueOnce(new Error('syntax error near "SELEKT"'));

        const result = await provider.executeAsync(makeContext('SELEKT 1'));

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/syntax error/i);
    });

    it('should call client.end() even when the query throws', async () => {
        mockPgQuery.mockRejectedValueOnce(new Error('query failed'));

        await provider.executeAsync(makeContext('BAD SQL'));

        expect(mockPgEnd).toHaveBeenCalledOnce();
    });

    // -----------------------------------------------------------------------
    // executeAsync — metadata
    // -----------------------------------------------------------------------

    it('should populate source, language, defaultOutputFormat on success', async () => {
        mockPgQuery.mockResolvedValueOnce({ fields: [{ name: 'val' }], rows: [{ val: 42 }] });

        const result = await provider.executeAsync(makeContext('SELECT 42 AS val', 'pg-db'));

        expect(result.source).toBe('pg-db');
        expect(result.language).toBe('sql');
        expect(result.defaultOutputFormat).toBe('table');
        expect(typeof result.executionTime).toBe('number');
    });

    // -----------------------------------------------------------------------
    // getSchemaAsync
    // -----------------------------------------------------------------------

    it('should return tables with columns and primary key info', async () => {
        mockPgQuery
            // Tables
            .mockResolvedValueOnce({
                rows: [
                    { table_name: 'users', table_type: 'BASE TABLE' },
                    { table_name: 'user_view', table_type: 'VIEW' },
                ],
            })
            // Columns for 'users'
            .mockResolvedValueOnce({
                rows: [
                    { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
                    { column_name: 'name', data_type: 'character varying', is_nullable: 'YES' },
                ],
            })
            // PK for 'users'
            .mockResolvedValueOnce({ rows: [{ column_name: 'id' }] })
            // Columns for 'user_view'
            .mockResolvedValueOnce({
                rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO' }],
            })
            // PK for 'user_view'
            .mockResolvedValueOnce({ rows: [] });

        const schema = await provider.getSchemaAsync(makeProviderOptions('pg-db'));

        expect(schema.source).toBe('pg-db');
        expect(schema.tables).toHaveLength(2);

        const usersTable = schema.tables.find((t) => t.name === 'users')!;
        expect(usersTable.type).toBe('table');

        const idCol = usersTable.columns.find((c) => c.name === 'id')!;
        expect(idCol.primaryKey).toBe(true);
        expect(idCol.nullable).toBe(false);

        const nameCol = usersTable.columns.find((c) => c.name === 'name')!;
        expect(nameCol.primaryKey).toBe(false);
        expect(nameCol.nullable).toBe(true);

        const viewTable = schema.tables.find((t) => t.name === 'user_view')!;
        expect(viewTable.type).toBe('view');
    });
});

// ===========================================================================
// MysqlDataExplorerProvider
// ===========================================================================

describe('MysqlDataExplorerProvider', () => {
    let provider: MysqlDataExplorerProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new MysqlDataExplorerProvider({
            connectionString: 'mysql://root:demo@localhost:3306/demo',
        });
        mockMysqlEnd.mockResolvedValue(undefined);
    });

    // -----------------------------------------------------------------------
    // Instantiation
    // -----------------------------------------------------------------------

    it('should be instantiable', () => {
        expect(provider).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // executeAsync — happy path
    // -----------------------------------------------------------------------

    it('should execute a query and return tabular results', async () => {
        mockMysqlExecute.mockResolvedValueOnce([
            [{ id: 1, email: 'a@b.com' }, { id: 2, email: 'c@d.com' }],
            [{ name: 'id' }, { name: 'email' }] as any,
        ]);

        const result = await provider.executeAsync(makeContext('SELECT id, email FROM users'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['id', 'email']);
        expect(result.rows).toEqual([
            [1, 'a@b.com'],
            [2, 'c@d.com'],
        ]);
        expect(result.rowCount).toBe(2);
    });

    it('should return empty rows when query returns no records', async () => {
        mockMysqlExecute.mockResolvedValueOnce([
            [],
            [{ name: 'id' }] as any,
        ]);

        const result = await provider.executeAsync(makeContext('SELECT * FROM empty'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['id']);
        expect(result.rows).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // executeAsync — error handling
    // -----------------------------------------------------------------------

    it('should return error result when query throws', async () => {
        mockMysqlExecute.mockRejectedValueOnce(new Error('Table not found'));

        const result = await provider.executeAsync(makeContext('SELECT * FROM nonexistent'));

        expect(result.success).toBe(false);
        expect(result.error).toBe('Table not found');
        expect(result.rows).toEqual([]);
    });

    it('should call connection.end() even when query throws', async () => {
        mockMysqlExecute.mockRejectedValueOnce(new Error('oops'));

        await provider.executeAsync(makeContext('SELECT 1'));

        expect(mockMysqlEnd).toHaveBeenCalledOnce();
    });

    // -----------------------------------------------------------------------
    // executeAsync — metadata
    // -----------------------------------------------------------------------

    it('should populate result metadata on success', async () => {
        mockMysqlExecute.mockResolvedValueOnce([
            [{ n: 1 }],
            [{ name: 'n' }] as any,
        ]);

        const result = await provider.executeAsync(makeContext('SELECT 1 AS n', 'mysql-db'));

        expect(result.source).toBe('mysql-db');
        expect(result.language).toBe('sql');
        expect(result.truncated).toBe(false);
        expect(typeof result.executionTime).toBe('number');
    });

    // -----------------------------------------------------------------------
    // getSchemaAsync
    // -----------------------------------------------------------------------

    it('should return tables with columns', async () => {
        mockMysqlExecute
            // Tables
            .mockResolvedValueOnce([
                [
                    { table_name: 'orders', table_type: 'BASE TABLE' },
                    { table_name: 'order_view', table_type: 'VIEW' },
                ],
                [],
            ])
            // Columns for 'orders'
            .mockResolvedValueOnce([
                [
                    { COLUMN_NAME: 'order_id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI' },
                    { COLUMN_NAME: 'amount', DATA_TYPE: 'decimal', IS_NULLABLE: 'YES', COLUMN_KEY: '' },
                ],
                [],
            ])
            // Columns for 'order_view'
            .mockResolvedValueOnce([
                [
                    { COLUMN_NAME: 'order_id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: '' },
                ],
                [],
            ]);

        const schema = await provider.getSchemaAsync(makeProviderOptions('mysql-db'));

        expect(schema.source).toBe('mysql-db');
        expect(schema.tables).toHaveLength(2);

        const ordersTable = schema.tables.find((t) => t.name === 'orders')!;
        expect(ordersTable.type).toBe('table');

        const pkCol = ordersTable.columns.find((c) => c.name === 'order_id')!;
        expect(pkCol.primaryKey).toBe(true);
        expect(pkCol.nullable).toBe(false);

        const amountCol = ordersTable.columns.find((c) => c.name === 'amount')!;
        expect(amountCol.primaryKey).toBe(false);
        expect(amountCol.nullable).toBe(true);

        const viewTable = schema.tables.find((t) => t.name === 'order_view')!;
        expect(viewTable.type).toBe('view');
    });
});

// ===========================================================================
// MssqlDataExplorerProvider
// ===========================================================================

describe('MssqlDataExplorerProvider', () => {
    let provider: MssqlDataExplorerProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new MssqlDataExplorerProvider({
            connectionString: 'Server=localhost,1433;Database=master;User Id=sa;Password=Demo@12345',
        });
        mockMssqlPoolClose.mockResolvedValue(undefined);
        mockPool.request.mockReturnValue(mockRequest);
        mockRequest.input.mockReturnThis();
    });

    // -----------------------------------------------------------------------
    // Instantiation
    // -----------------------------------------------------------------------

    it('should be instantiable', () => {
        expect(provider).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // executeAsync — happy path
    // -----------------------------------------------------------------------

    it('should execute a query and return tabular results', async () => {
        const recordset = [
            { ProductID: 1, Name: 'Widget' },
            { ProductID: 2, Name: 'Gadget' },
        ];
        (recordset as any).columns = { ProductID: {}, Name: {} };

        mockMssqlQuery.mockResolvedValueOnce({ recordset });

        const result = await provider.executeAsync(makeContext('SELECT ProductID, Name FROM Products'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['ProductID', 'Name']);
        expect(result.rows).toEqual([
            [1, 'Widget'],
            [2, 'Gadget'],
        ]);
        expect(result.rowCount).toBe(2);
    });

    it('should fall back to Object.keys of first row when recordset.columns is null', async () => {
        const recordset = [{ id: 1, val: 'hello' }];
        (recordset as any).columns = null;

        mockMssqlQuery.mockResolvedValueOnce({ recordset });

        const result = await provider.executeAsync(makeContext('SELECT id, val FROM t'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual(['id', 'val']);
        expect(result.rows).toEqual([[1, 'hello']]);
    });

    it('should return empty columns and rows for empty recordset', async () => {
        const recordset: unknown[] = [];
        (recordset as any).columns = null;

        mockMssqlQuery.mockResolvedValueOnce({ recordset });

        const result = await provider.executeAsync(makeContext('SELECT 1 WHERE 1=0'));

        expect(result.success).toBe(true);
        expect(result.columns).toEqual([]);
        expect(result.rows).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // executeAsync — error handling
    // -----------------------------------------------------------------------

    it('should return error result when pool.request().query() throws', async () => {
        mockMssqlQuery.mockRejectedValueOnce(new Error('Login failed'));

        const result = await provider.executeAsync(makeContext('SELECT 1'));

        expect(result.success).toBe(false);
        expect(result.error).toBe('Login failed');
        expect(result.rows).toEqual([]);
    });

    it('should close the pool even when query throws', async () => {
        mockMssqlQuery.mockRejectedValueOnce(new Error('oops'));

        await provider.executeAsync(makeContext('SELECT 1'));

        expect(mockMssqlPoolClose).toHaveBeenCalledOnce();
    });

    // -----------------------------------------------------------------------
    // executeAsync — metadata
    // -----------------------------------------------------------------------

    it('should populate result metadata on success', async () => {
        const recordset: unknown[] = [{ x: 1 }];
        (recordset as any).columns = { x: {} };
        mockMssqlQuery.mockResolvedValueOnce({ recordset });

        const result = await provider.executeAsync(makeContext('SELECT 1 AS x', 'mssql-db'));

        expect(result.source).toBe('mssql-db');
        expect(result.language).toBe('sql');
        expect(result.truncated).toBe(false);
        expect(typeof result.executionTime).toBe('number');
    });

    // -----------------------------------------------------------------------
    // getSchemaAsync
    // -----------------------------------------------------------------------

    it('should return tables with columns and identity-based primary keys', async () => {
        mockMssqlQuery
            // Tables
            .mockResolvedValueOnce({
                recordset: [
                    { TABLE_NAME: 'Customers', TABLE_TYPE: 'BASE TABLE' },
                    { TABLE_NAME: 'CustomerView', TABLE_TYPE: 'VIEW' },
                ],
            })
            // Columns for 'Customers'
            .mockResolvedValueOnce({
                recordset: [
                    { COLUMN_NAME: 'CustomerID', DATA_TYPE: 'int', IS_NULLABLE: 'NO', IS_IDENTITY: 1 },
                    { COLUMN_NAME: 'FullName', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'YES', IS_IDENTITY: null },
                ],
            })
            // Columns for 'CustomerView'
            .mockResolvedValueOnce({
                recordset: [
                    { COLUMN_NAME: 'CustomerID', DATA_TYPE: 'int', IS_NULLABLE: 'NO', IS_IDENTITY: null },
                ],
            });

        const schema = await provider.getSchemaAsync(makeProviderOptions('mssql-db'));

        expect(schema.source).toBe('mssql-db');
        expect(schema.tables).toHaveLength(2);

        const customersTable = schema.tables.find((t) => t.name === 'Customers')!;
        expect(customersTable.type).toBe('table');

        const pkCol = customersTable.columns.find((c) => c.name === 'CustomerID')!;
        expect(pkCol.primaryKey).toBe(true);   // IS_IDENTITY === 1
        expect(pkCol.nullable).toBe(false);
        expect(pkCol.type).toBe('int');

        const nameCol = customersTable.columns.find((c) => c.name === 'FullName')!;
        expect(nameCol.primaryKey).toBe(false); // IS_IDENTITY is null
        expect(nameCol.nullable).toBe(true);

        const viewTable = schema.tables.find((t) => t.name === 'CustomerView')!;
        expect(viewTable.type).toBe('view');
    });

    it('should close the pool after getSchemaAsync completes', async () => {
        mockMssqlQuery.mockResolvedValueOnce({ recordset: [] });

        await provider.getSchemaAsync(makeProviderOptions());

        expect(mockMssqlPoolClose).toHaveBeenCalledOnce();
    });
});
