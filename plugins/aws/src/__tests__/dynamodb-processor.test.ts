import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBClient,
    ListTablesCommand,
    DescribeTableCommand,
    ScanCommand,
    QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { AwsDynamoDbProcessor } from '../processors/dynamodb-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const dynamoMock = mockClient(DynamoDBClient);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return {
        command: 'aws dynamodb',
        rawCommand: 'aws dynamodb',
        chainCommands: [],
        args: {},
        ...overrides,
    };
}

describe('AwsDynamoDbProcessor', () => {
    let processor: AwsDynamoDbProcessor;
    let credentialManager: AwsCredentialManager;

    beforeEach(() => {
        dynamoMock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        credentialManager = new AwsCredentialManager(configService);
        processor = new AwsDynamoDbProcessor(credentialManager);
    });

    function findSub(name: string) {
        const sub = processor.processors!.find((p) => p.command === name);
        if (!sub) throw new Error(`Sub-processor "${name}" not found`);
        return sub;
    }

    // -------------------------------------------------------------------
    // tables
    // -------------------------------------------------------------------
    describe('tables', () => {
        it('should return list of table names', async () => {
            dynamoMock.on(ListTablesCommand).resolves({
                TableNames: ['users-table', 'orders-table', 'products-table'],
            });

            const sub = findSub('tables');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('users-table');
            expect(text).toContain('orders-table');
            expect(text).toContain('products-table');
        });

        it('should return warning when no tables found', async () => {
            dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });

            const sub = findSub('tables');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No DynamoDB tables found');
        });
    });

    // -------------------------------------------------------------------
    // describe
    // -------------------------------------------------------------------
    describe('describe', () => {
        it('should return key-value details for a table', async () => {
            dynamoMock.on(DescribeTableCommand).resolves({
                Table: {
                    TableName: 'users-table',
                    TableStatus: 'ACTIVE',
                    ItemCount: 42,
                    TableSizeBytes: 1024,
                    KeySchema: [
                        { AttributeName: 'id', KeyType: 'HASH' },
                        { AttributeName: 'sort', KeyType: 'RANGE' },
                    ],
                    CreationDateTime: new Date('2024-01-15T10:00:00.000Z'),
                },
            });

            const sub = findSub('describe');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'users-table' }));

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('users-table');
            expect(text).toContain('ACTIVE');
            expect(text).toContain('42');
            expect(text).toContain('id (HASH)');
            expect(text).toContain('sort (RANGE)');
            expect(text).toContain('2024-01-15T10:00:00.000Z');
        });

        it('should return error when table name is missing', async () => {
            const sub = findSub('describe');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Table name is required');
        });
    });

    // -------------------------------------------------------------------
    // scan
    // -------------------------------------------------------------------
    describe('scan', () => {
        it('should return JSON items from table', async () => {
            dynamoMock.on(ScanCommand).resolves({
                Items: [
                    { id: { S: 'user-001' }, name: { S: 'Alice' }, age: { N: '30' } },
                    { id: { S: 'user-002' }, name: { S: 'Bob' }, age: { N: '25' } },
                ],
                Count: 2,
            });

            const sub = findSub('scan');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'users-table' }));

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('user-001');
            expect(text).toContain('Alice');
            expect(text).toContain('user-002');
            expect(text).toContain('Bob');
        });

        it('should return error when table name is missing', async () => {
            const sub = findSub('scan');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Table name is required');
        });
    });

    // -------------------------------------------------------------------
    // query
    // -------------------------------------------------------------------
    describe('query', () => {
        it('should return JSON items matching the key condition', async () => {
            dynamoMock.on(QueryCommand).resolves({
                Items: [
                    { id: { S: 'user-001' }, name: { S: 'Alice' } },
                ],
                Count: 1,
            });

            const sub = findSub('query');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 'users-table',
                    args: { key: 'id = :id' },
                }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('user-001');
            expect(text).toContain('Alice');
        });

        it('should return error when table name is missing', async () => {
            const sub = findSub('query');
            const result = await sub.handleStructuredAsync!(makeCommand({ args: { key: 'id = :id' } }));

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Table name is required');
        });

        it('should return error when --key is missing', async () => {
            const sub = findSub('query');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'users-table' }));

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('--key');
            expect(text).toContain('required');
        });
    });
});
