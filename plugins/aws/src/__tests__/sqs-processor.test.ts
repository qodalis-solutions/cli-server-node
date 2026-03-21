import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    SQSClient,
    ListQueuesCommand,
    SendMessageCommand,
    ReceiveMessageCommand,
    PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import { AwsSqsProcessor } from '../processors/sqs-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const sqsMock = mockClient(SQSClient);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return {
        command: 'aws sqs',
        rawCommand: 'aws sqs',
        chainCommands: [],
        args: {},
        ...overrides,
    };
}

describe('AwsSqsProcessor', () => {
    let processor: AwsSqsProcessor;
    let credentialManager: AwsCredentialManager;

    beforeEach(() => {
        sqsMock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        credentialManager = new AwsCredentialManager(configService);
        processor = new AwsSqsProcessor(credentialManager);
    });

    function findSub(name: string) {
        const sub = processor.processors!.find((p) => p.command === name);
        if (!sub) throw new Error(`Sub-processor "${name}" not found`);
        return sub;
    }

    // -------------------------------------------------------------------
    // list
    // -------------------------------------------------------------------
    describe('list', () => {
        it('should return list of queue URLs', async () => {
            sqsMock.on(ListQueuesCommand).resolves({
                QueueUrls: [
                    'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
                    'https://sqs.us-east-1.amazonaws.com/123456789012/another-queue',
                ],
            });

            const sub = findSub('list');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('my-queue');
            expect(text).toContain('another-queue');
        });

        it('should return warning when no queues found', async () => {
            sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });

            const sub = findSub('list');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No SQS queues found');
        });
    });

    // -------------------------------------------------------------------
    // send
    // -------------------------------------------------------------------
    describe('send', () => {
        it('should return success with MessageId', async () => {
            sqsMock.on(SendMessageCommand).resolves({
                MessageId: 'abc-123-def-456',
            });

            const sub = findSub('send');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
                    args: { message: 'Hello, SQS!' },
                }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('abc-123-def-456');
            expect(text).toContain('Message sent successfully');
        });

        it('should return error when queue URL is missing', async () => {
            const sub = findSub('send');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ args: { message: 'Hello, SQS!' } }),
            );

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Queue URL is required');
        });

        it('should return error when --message is missing', async () => {
            const sub = findSub('send');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
                }),
            );

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('--message is required');
        });
    });

    // -------------------------------------------------------------------
    // receive
    // -------------------------------------------------------------------
    describe('receive', () => {
        it('should return JSON messages', async () => {
            sqsMock.on(ReceiveMessageCommand).resolves({
                Messages: [
                    {
                        MessageId: 'msg-001',
                        Body: 'Hello from SQS',
                        ReceiptHandle: 'receipt-handle-001',
                    },
                    {
                        MessageId: 'msg-002',
                        Body: 'Another message',
                        ReceiptHandle: 'receipt-handle-002',
                    },
                ],
            });

            const sub = findSub('receive');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
                    args: { max: 2 },
                }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('msg-001');
            expect(text).toContain('Hello from SQS');
            expect(text).toContain('msg-002');
            expect(text).toContain('Another message');
        });

        it('should return warning when no messages available', async () => {
            sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });

            const sub = findSub('receive');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
                }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No messages available');
        });

        it('should return error when queue URL is missing', async () => {
            const sub = findSub('receive');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Queue URL is required');
        });
    });

    // -------------------------------------------------------------------
    // purge
    // -------------------------------------------------------------------
    describe('purge', () => {
        it('should return success after purging the queue', async () => {
            sqsMock.on(PurgeQueueCommand).resolves({});

            const sub = findSub('purge');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
                }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Queue purged successfully');
        });

        it('should return dry-run warning without actually purging', async () => {
            const sub = findSub('purge');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
                    args: { 'dry-run': true },
                }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('dry-run');
            expect(text).toContain('my-queue');

            // PurgeQueueCommand should NOT have been called
            const calls = sqsMock.calls();
            expect(calls.length).toBe(0);
        });

        it('should return error when queue URL is missing', async () => {
            const sub = findSub('purge');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Queue URL is required');
        });
    });
});
