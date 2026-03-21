import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import {
    SNSClient,
    ListTopicsCommand,
    PublishCommand,
    ListSubscriptionsCommand,
    ListSubscriptionsByTopicCommand,
} from '@aws-sdk/client-sns';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    buildSuccessResponse,
    formatAsTable,
    formatAsList,
    applyOutputFormat,
} from '../utils/output-helpers';

// ---------------------------------------------------------------------------
// sns topics
// ---------------------------------------------------------------------------

class SnsTopicsProcessor extends CliCommandProcessor {
    command = 'topics';
    description = 'List SNS topics';
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('output', 'Output format (table|json|text)', false, 'string', ['-o'], 'table'),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const client = this.credentialManager.getClient(SNSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new ListTopicsCommand({}));
            const topics = response.Topics ?? [];

            if (topics.length === 0) {
                return buildResponse([{ type: 'text', value: 'No SNS topics found.', style: 'warning' }]);
            }

            const arns = topics.map((t) => t.TopicArn ?? '(unknown)');
            const listOutput = formatAsList(arns);
            return buildResponse([applyOutputFormat(command, listOutput, topics)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list SNS topics: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// sns publish
// ---------------------------------------------------------------------------

class SnsPublishProcessor extends CliCommandProcessor {
    command = 'publish';
    description = 'Publish a message to an SNS topic';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('message', 'Message to publish', true, 'string', ['-m']),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const topicArn = command.value?.trim();
        if (!topicArn) {
            return buildErrorResponse('Topic ARN is required. Usage: sns publish <topic-arn> --message <message>');
        }

        const message = command.args?.message as string | undefined;
        if (!message) {
            return buildErrorResponse('--message is required. Usage: sns publish <topic-arn> --message <message>');
        }

        const client = this.credentialManager.getClient(SNSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(
                new PublishCommand({
                    TopicArn: topicArn,
                    Message: message,
                }),
            );

            return buildSuccessResponse(`Message published successfully. MessageId: ${response.MessageId ?? '(unknown)'}`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to publish message: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// sns subscriptions
// ---------------------------------------------------------------------------

class SnsSubscriptionsProcessor extends CliCommandProcessor {
    command = 'subscriptions';
    description = 'List SNS subscriptions (optionally filtered by topic ARN)';
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('output', 'Output format (table|json|text)', false, 'string', ['-o'], 'table'),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const topicArn = command.value?.trim();

        const client = this.credentialManager.getClient(SNSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            let subscriptions: any[];

            if (topicArn) {
                const response = await client.send(
                    new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
                );
                subscriptions = response.Subscriptions ?? [];
            } else {
                const response = await client.send(new ListSubscriptionsCommand({}));
                subscriptions = response.Subscriptions ?? [];
            }

            if (subscriptions.length === 0) {
                return buildResponse([{ type: 'text', value: 'No SNS subscriptions found.', style: 'warning' }]);
            }

            const rows = subscriptions.map((sub) => [
                sub.SubscriptionArn ?? '(unknown)',
                sub.Protocol ?? '(unknown)',
                sub.Endpoint ?? '(unknown)',
                sub.TopicArn ?? '(unknown)',
            ]);

            const tableOutput = formatAsTable(['SubscriptionArn', 'Protocol', 'Endpoint', 'TopicArn'], rows);
            return buildResponse([applyOutputFormat(command, tableOutput, subscriptions)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list SNS subscriptions: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// sns (parent)
// ---------------------------------------------------------------------------

export class AwsSnsProcessor extends CliCommandProcessor {
    command = 'sns';
    description = 'AWS SNS operations — topics, publish, subscriptions';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new SnsTopicsProcessor(credentialManager),
            new SnsPublishProcessor(credentialManager),
            new SnsSubscriptionsProcessor(credentialManager),
        ];
    }

    async handleAsync(): Promise<string> {
        return '';
    }
}
