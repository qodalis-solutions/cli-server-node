import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import {
    SQSClient,
    ListQueuesCommand,
    SendMessageCommand,
    ReceiveMessageCommand,
    PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    buildSuccessResponse,
    formatAsJson,
    formatAsList,
    applyOutputFormat,
    isDryRun,
} from '../utils/output-helpers';

// ---------------------------------------------------------------------------
// sqs list
// ---------------------------------------------------------------------------

class SqsListProcessor extends CliCommandProcessor {
    command = 'list';
    description = 'List SQS queues';
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('output', 'Output format (list|json|text)', false, 'string', ['-o'], 'list'),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const client = this.credentialManager.getClient(SQSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new ListQueuesCommand({}));
            const queueUrls = response.QueueUrls ?? [];

            if (queueUrls.length === 0) {
                return buildResponse([{ type: 'text', value: 'No SQS queues found.', style: 'warning' }]);
            }

            const listOutput = formatAsList(queueUrls);
            return buildResponse([applyOutputFormat(command, listOutput, queueUrls)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list SQS queues: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// sqs send
// ---------------------------------------------------------------------------

class SqsSendProcessor extends CliCommandProcessor {
    command = 'send';
    description = 'Send a message to an SQS queue';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('message', 'Message body to send', true, 'string', ['-m']),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const queueUrl = command.value?.trim();
        if (!queueUrl) {
            return buildErrorResponse('Queue URL is required. Usage: sqs send <queue-url> --message <body>');
        }

        const messageBody = command.args?.message as string | undefined;
        if (!messageBody) {
            return buildErrorResponse('--message is required. Usage: sqs send <queue-url> --message <body>');
        }

        const client = this.credentialManager.getClient(SQSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(
                new SendMessageCommand({
                    QueueUrl: queueUrl,
                    MessageBody: messageBody,
                }),
            );

            return buildSuccessResponse(`Message sent successfully. MessageId: ${response.MessageId}`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to send message: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// sqs receive
// ---------------------------------------------------------------------------

class SqsReceiveProcessor extends CliCommandProcessor {
    command = 'receive';
    description = 'Receive messages from an SQS queue';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('max', 'Maximum number of messages to receive (default: 1)', false, 'number', ['-n'], '1'),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const queueUrl = command.value?.trim();
        if (!queueUrl) {
            return buildErrorResponse('Queue URL is required. Usage: sqs receive <queue-url>');
        }

        const max = command.args?.max ? Number(command.args.max) : 1;

        const client = this.credentialManager.getClient(SQSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(
                new ReceiveMessageCommand({
                    QueueUrl: queueUrl,
                    MaxNumberOfMessages: max,
                }),
            );

            const messages = response.Messages ?? [];

            if (messages.length === 0) {
                return buildResponse([{ type: 'text', value: 'No messages available in the queue.', style: 'warning' }]);
            }

            return buildResponse([formatAsJson(messages)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to receive messages: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// sqs purge
// ---------------------------------------------------------------------------

class SqsPurgeProcessor extends CliCommandProcessor {
    command = 'purge';
    description = 'Purge all messages from an SQS queue';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('dry-run', 'Show what would be purged without actually purging', false, 'boolean', ['--dry-run']),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const queueUrl = command.value?.trim();
        if (!queueUrl) {
            return buildErrorResponse('Queue URL is required. Usage: sqs purge <queue-url>');
        }

        if (isDryRun(command)) {
            return buildResponse([
                { type: 'text', value: `[dry-run] Would purge all messages from queue: ${queueUrl}`, style: 'warning' },
            ]);
        }

        const client = this.credentialManager.getClient(SQSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
            return buildSuccessResponse(`Queue purged successfully: ${queueUrl}`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to purge queue: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// sqs (parent)
// ---------------------------------------------------------------------------

export class AwsSqsProcessor extends CliCommandProcessor {
    command = 'sqs';
    description = 'AWS SQS operations — list, send, receive, purge';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new SqsListProcessor(credentialManager),
            new SqsSendProcessor(credentialManager),
            new SqsReceiveProcessor(credentialManager),
            new SqsPurgeProcessor(credentialManager),
        ];
    }

    async handleAsync(): Promise<string> {
        return '';
    }
}
