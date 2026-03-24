import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import {
    LambdaClient,
    ListFunctionsCommand,
    InvokeCommand,
} from '@aws-sdk/client-lambda';
import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    formatAsTable,
    formatAsJson,
    applyOutputFormat,
} from '../utils/output-helpers';

/** Sub-processor that lists Lambda functions. */
class LambdaListProcessor extends CliCommandProcessor {
    command = 'list';
    description = 'List Lambda functions';
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('output', 'Output format (table|json|text)', false, 'string', ['-o'], 'table'),
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
        const client = this.credentialManager.getClient(LambdaClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new ListFunctionsCommand({}));
            const functions = response.Functions ?? [];

            if (functions.length === 0) {
                return buildResponse([{ type: 'text', value: 'No Lambda functions found.', style: 'warning' }]);
            }

            const rows = functions.map((fn) => [
                fn.FunctionName ?? '(unknown)',
                fn.Runtime ?? '(unknown)',
                fn.MemorySize !== undefined ? String(fn.MemorySize) : '(unknown)',
                fn.LastModified ?? '(unknown)',
            ]);

            const tableOutput = formatAsTable(['Name', 'Runtime', 'Memory (MB)', 'Last Modified'], rows);
            return buildResponse([applyOutputFormat(command, tableOutput, functions)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list Lambda functions: ${err.message ?? err}`);
        }
    }
}

/** Sub-processor that invokes a Lambda function with an optional JSON payload. */
class LambdaInvokeProcessor extends CliCommandProcessor {
    command = 'invoke';
    description = 'Invoke a Lambda function';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('payload', 'JSON payload to send to the function', false, 'string', ['-p']),
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
        const functionName = command.value?.trim();
        if (!functionName) {
            return buildErrorResponse('Function name is required. Usage: lambda invoke <function-name>');
        }

        const client = this.credentialManager.getClient(LambdaClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        const payloadStr = command.args?.payload as string | undefined;

        try {
            const params: any = { FunctionName: functionName };
            if (payloadStr) {
                params.Payload = new TextEncoder().encode(payloadStr);
            }

            const response = await client.send(new InvokeCommand(params));

            if (response.FunctionError) {
                const errorBody = response.Payload
                    ? new TextDecoder().decode(response.Payload)
                    : '(no details)';
                return buildErrorResponse(`Function error (${response.FunctionError}): ${errorBody}`);
            }

            const resultBody = response.Payload
                ? new TextDecoder().decode(response.Payload)
                : 'null';

            let parsed: any;
            try {
                parsed = JSON.parse(resultBody);
            } catch {
                parsed = resultBody;
            }

            return buildResponse([
                formatAsJson({
                    StatusCode: response.StatusCode,
                    ExecutedVersion: response.ExecutedVersion ?? '(unknown)',
                    Result: parsed,
                }),
            ]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to invoke function: ${err.message ?? err}`);
        }
    }
}

/** Sub-processor that fetches recent CloudWatch logs for a Lambda function. */
class LambdaLogsProcessor extends CliCommandProcessor {
    command = 'logs';
    description = 'View recent logs for a Lambda function';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('limit', 'Maximum number of log events (default: 50)', false, 'number', ['-l'], '50'),
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
        const functionName = command.value?.trim();
        if (!functionName) {
            return buildErrorResponse('Function name is required. Usage: lambda logs <function-name>');
        }

        const limit = command.args?.limit ? Number(command.args.limit) : 50;
        if (isNaN(limit) || limit <= 0) {
            return buildErrorResponse('--limit must be a positive number.');
        }

        const client = this.credentialManager.getClient(CloudWatchLogsClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        const logGroupName = `/aws/lambda/${functionName}`;

        try {
            const response = await client.send(
                new FilterLogEventsCommand({
                    logGroupName,
                    limit,
                }),
            );

            const events = response.events ?? [];

            if (events.length === 0) {
                return buildResponse([{ type: 'text', value: `No log events found for ${logGroupName}.`, style: 'warning' }]);
            }

            const lines = events.map((event) => {
                const timestamp = event.timestamp
                    ? new Date(event.timestamp).toISOString().slice(0, 19).replace('T', ' ')
                    : '(unknown)';
                const message = (event.message ?? '').trimEnd();
                return `${timestamp}  ${message}`;
            });

            return buildResponse([{ type: 'text', value: lines.join('\n') }]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to fetch logs: ${err.message ?? err}`);
        }
    }
}

/** Parent processor for Lambda sub-commands (list, invoke, logs). */
export class AwsLambdaProcessor extends CliCommandProcessor {
    command = 'lambda';
    description = 'AWS Lambda operations — list, invoke, and view logs';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new LambdaListProcessor(credentialManager),
            new LambdaInvokeProcessor(credentialManager),
            new LambdaLogsProcessor(credentialManager),
        ];
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }
}
