import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import {
    DynamoDBClient,
    ListTablesCommand,
    DescribeTableCommand,
    ScanCommand,
    QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    formatAsJson,
    formatAsList,
    formatAsKeyValue,
    applyOutputFormat,
} from '../utils/output-helpers';

/** Sub-processor that lists DynamoDB tables. */
class DynamoDbTablesProcessor extends CliCommandProcessor {
    command = 'tables';
    description = 'List DynamoDB tables';
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('output', 'Output format (list|json|text)', false, 'string', ['-o'], 'list'),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const client = this.credentialManager.getClient(DynamoDBClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new ListTablesCommand({}));
            const tableNames = response.TableNames ?? [];

            if (tableNames.length === 0) {
                return buildResponse([{ type: 'text', value: 'No DynamoDB tables found.', style: 'warning' }]);
            }

            const listOutput = formatAsList(tableNames);
            return buildResponse([applyOutputFormat(command, listOutput, tableNames)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list DynamoDB tables: ${err.message ?? err}`);
        }
    }
}

/** Sub-processor that describes a DynamoDB table's metadata (key schema, item count, etc.). */
class DynamoDbDescribeProcessor extends CliCommandProcessor {
    command = 'describe';
    description = 'Describe a DynamoDB table';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const tableName = command.value?.trim();
        if (!tableName) {
            return buildErrorResponse('Table name is required. Usage: dynamodb describe <table-name>');
        }

        const client = this.credentialManager.getClient(DynamoDBClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new DescribeTableCommand({ TableName: tableName }));
            const table = response.Table;

            if (!table) {
                return buildErrorResponse(`Table "${tableName}" not found.`);
            }

            const keySchema = (table.KeySchema ?? [])
                .map((k) => `${k.AttributeName} (${k.KeyType})`)
                .join(', ');

            const entries: Record<string, string> = {
                TableName: table.TableName ?? '(unknown)',
                TableStatus: table.TableStatus ?? '(unknown)',
                ItemCount: String(table.ItemCount ?? 0),
                TableSizeBytes: String(table.TableSizeBytes ?? 0),
                KeySchema: keySchema,
                CreationDateTime: table.CreationDateTime ? table.CreationDateTime.toISOString() : '(unknown)',
            };

            return buildResponse([formatAsKeyValue(entries)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to describe DynamoDB table: ${err.message ?? err}`);
        }
    }
}

/** Sub-processor that scans items from a DynamoDB table. */
class DynamoDbScanProcessor extends CliCommandProcessor {
    command = 'scan';
    description = 'Scan items from a DynamoDB table';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('limit', 'Maximum number of items to return (default: 25)', false, 'number', ['-l'], '25'),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const tableName = command.value?.trim();
        if (!tableName) {
            return buildErrorResponse('Table name is required. Usage: dynamodb scan <table-name>');
        }

        const limit = command.args?.limit ? Number(command.args.limit) : 25;

        const client = this.credentialManager.getClient(DynamoDBClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(
                new ScanCommand({
                    TableName: tableName,
                    Limit: limit,
                }),
            );

            const items = response.Items ?? [];
            return buildResponse([formatAsJson(items)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to scan DynamoDB table: ${err.message ?? err}`);
        }
    }
}

/** Sub-processor that queries items from a DynamoDB table using a key condition expression. */
class DynamoDbQueryProcessor extends CliCommandProcessor {
    command = 'query';
    description = 'Query items from a DynamoDB table';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('key', 'KeyConditionExpression for the query', true, 'string', ['-k']),
        new CliCommandParameterDescriptor('filter', 'FilterExpression for the query', false, 'string', ['-f']),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const tableName = command.value?.trim();
        if (!tableName) {
            return buildErrorResponse('Table name is required. Usage: dynamodb query <table-name> --key <expression>');
        }

        const keyCondition = command.args?.key as string | undefined;
        if (!keyCondition) {
            return buildErrorResponse('--key (KeyConditionExpression) is required. Usage: dynamodb query <table-name> --key <expression>');
        }

        const filterExpression = command.args?.filter as string | undefined;

        const client = this.credentialManager.getClient(DynamoDBClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(
                new QueryCommand({
                    TableName: tableName,
                    KeyConditionExpression: keyCondition,
                    FilterExpression: filterExpression,
                }),
            );

            const items = response.Items ?? [];
            return buildResponse([formatAsJson(items)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to query DynamoDB table: ${err.message ?? err}`);
        }
    }
}

/** Parent processor for DynamoDB sub-commands (tables, describe, scan, query). */
export class AwsDynamoDbProcessor extends CliCommandProcessor {
    command = 'dynamodb';
    description = 'AWS DynamoDB operations — tables, describe, scan, query';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new DynamoDbTablesProcessor(credentialManager),
            new DynamoDbDescribeProcessor(credentialManager),
            new DynamoDbScanProcessor(credentialManager),
            new DynamoDbQueryProcessor(credentialManager),
        ];
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }
}
