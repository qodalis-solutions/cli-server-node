import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    SNSClient,
    ListTopicsCommand,
    PublishCommand,
    ListSubscriptionsCommand,
    ListSubscriptionsByTopicCommand,
} from '@aws-sdk/client-sns';
import { AwsSnsProcessor } from '../processors/sns-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const snsMock = mockClient(SNSClient);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return {
        command: 'aws sns',
        rawCommand: 'aws sns',
        chainCommands: [],
        args: {},
        ...overrides,
    };
}

describe('AwsSnsProcessor', () => {
    let processor: AwsSnsProcessor;
    let credentialManager: AwsCredentialManager;

    beforeEach(() => {
        snsMock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        credentialManager = new AwsCredentialManager(configService);
        processor = new AwsSnsProcessor(credentialManager);
    });

    function findSub(name: string) {
        const sub = processor.processors!.find((p) => p.command === name);
        if (!sub) throw new Error(`Sub-processor "${name}" not found`);
        return sub;
    }

    // -------------------------------------------------------------------
    // topics
    // -------------------------------------------------------------------
    describe('topics', () => {
        it('should return list of topic ARNs', async () => {
            snsMock.on(ListTopicsCommand).resolves({
                Topics: [
                    { TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic' },
                    { TopicArn: 'arn:aws:sns:us-east-1:123456789012:another-topic' },
                ],
            });

            const sub = findSub('topics');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('arn:aws:sns:us-east-1:123456789012:my-topic');
            expect(text).toContain('arn:aws:sns:us-east-1:123456789012:another-topic');
        });

        it('should return warning when no topics found', async () => {
            snsMock.on(ListTopicsCommand).resolves({ Topics: [] });

            const sub = findSub('topics');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No SNS topics found');
        });
    });

    // -------------------------------------------------------------------
    // publish
    // -------------------------------------------------------------------
    describe('publish', () => {
        it('should return success with MessageId', async () => {
            snsMock.on(PublishCommand).resolves({
                MessageId: 'abc-123-def-456',
            });

            const sub = findSub('publish');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 'arn:aws:sns:us-east-1:123456789012:my-topic',
                    args: { message: 'Hello, world!' },
                }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('abc-123-def-456');
            expect(text).toContain('published successfully');
        });

        it('should return error when topic ARN is missing', async () => {
            const sub = findSub('publish');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ args: { message: 'Hello!' } }),
            );

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Topic ARN is required');
        });

        it('should return error when --message is missing', async () => {
            const sub = findSub('publish');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'arn:aws:sns:us-east-1:123456789012:my-topic' }),
            );

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('--message is required');
        });
    });

    // -------------------------------------------------------------------
    // subscriptions
    // -------------------------------------------------------------------
    describe('subscriptions', () => {
        it('should return table of subscriptions', async () => {
            snsMock.on(ListSubscriptionsCommand).resolves({
                Subscriptions: [
                    {
                        SubscriptionArn: 'arn:aws:sns:us-east-1:123456789012:my-topic:sub-001',
                        Protocol: 'email',
                        Endpoint: 'user@example.com',
                        TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
                    },
                    {
                        SubscriptionArn: 'arn:aws:sns:us-east-1:123456789012:my-topic:sub-002',
                        Protocol: 'sqs',
                        Endpoint: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
                        TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
                    },
                ],
            });

            const sub = findSub('subscriptions');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('sub-001');
            expect(text).toContain('email');
            expect(text).toContain('user@example.com');
            expect(text).toContain('sub-002');
            expect(text).toContain('sqs');
        });

        it('should return warning when no subscriptions found', async () => {
            snsMock.on(ListSubscriptionsCommand).resolves({ Subscriptions: [] });

            const sub = findSub('subscriptions');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No SNS subscriptions found');
        });

        it('should use ListSubscriptionsByTopic when topic ARN is provided', async () => {
            snsMock.on(ListSubscriptionsByTopicCommand).resolves({
                Subscriptions: [
                    {
                        SubscriptionArn: 'arn:aws:sns:us-east-1:123456789012:filtered-topic:sub-003',
                        Protocol: 'https',
                        Endpoint: 'https://example.com/webhook',
                        TopicArn: 'arn:aws:sns:us-east-1:123456789012:filtered-topic',
                    },
                ],
            });

            const sub = findSub('subscriptions');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'arn:aws:sns:us-east-1:123456789012:filtered-topic' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('sub-003');
            expect(text).toContain('https');
            expect(text).toContain('https://example.com/webhook');
        });
    });
});
