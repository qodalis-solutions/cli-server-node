import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    LambdaClient,
    ListFunctionsCommand,
    InvokeCommand,
} from '@aws-sdk/client-lambda';
import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { AwsLambdaProcessor } from '../processors/lambda-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const lambdaMock = mockClient(LambdaClient);
const cwlMock = mockClient(CloudWatchLogsClient);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return {
        command: 'aws lambda',
        rawCommand: 'aws lambda',
        chainCommands: [],
        args: {},
        ...overrides,
    };
}

describe('AwsLambdaProcessor', () => {
    let processor: AwsLambdaProcessor;
    let credentialManager: AwsCredentialManager;

    beforeEach(() => {
        lambdaMock.reset();
        cwlMock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        credentialManager = new AwsCredentialManager(configService);
        processor = new AwsLambdaProcessor(credentialManager);
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
        it('should return table with function data', async () => {
            lambdaMock.on(ListFunctionsCommand).resolves({
                Functions: [
                    {
                        FunctionName: 'my-api-handler',
                        Runtime: 'nodejs20.x',
                        MemorySize: 256,
                        LastModified: '2024-06-15T10:30:00.000+0000',
                    },
                    {
                        FunctionName: 'data-processor',
                        Runtime: 'python3.12',
                        MemorySize: 512,
                        LastModified: '2024-07-01T08:00:00.000+0000',
                    },
                ],
            });

            const sub = findSub('list');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('my-api-handler');
            expect(text).toContain('nodejs20.x');
            expect(text).toContain('256');
            expect(text).toContain('data-processor');
            expect(text).toContain('python3.12');
            expect(text).toContain('512');
        });

        it('should return warning when no functions found', async () => {
            lambdaMock.on(ListFunctionsCommand).resolves({ Functions: [] });

            const sub = findSub('list');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No Lambda functions found');
        });
    });

    // -------------------------------------------------------------------
    // invoke
    // -------------------------------------------------------------------
    describe('invoke', () => {
        it('should return JSON output with invocation result', async () => {
            const responsePayload = JSON.stringify({ statusCode: 200, body: 'Hello' });
            lambdaMock.on(InvokeCommand).resolves({
                StatusCode: 200,
                ExecutedVersion: '$LATEST',
                Payload: new TextEncoder().encode(responsePayload) as any,
            });

            const sub = findSub('invoke');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'my-api-handler' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('200');
            expect(text).toContain('$LATEST');
            expect(text).toContain('Hello');
        });

        it('should handle function errors', async () => {
            const errorPayload = JSON.stringify({ errorMessage: 'Something went wrong' });
            lambdaMock.on(InvokeCommand).resolves({
                StatusCode: 200,
                FunctionError: 'Unhandled',
                Payload: new TextEncoder().encode(errorPayload) as any,
            });

            const sub = findSub('invoke');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'my-api-handler' }),
            );

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Unhandled');
            expect(text).toContain('Something went wrong');
        });

        it('should require a function name', async () => {
            const sub = findSub('invoke');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Function name is required');
        });
    });

    // -------------------------------------------------------------------
    // logs
    // -------------------------------------------------------------------
    describe('logs', () => {
        it('should return text with log entries', async () => {
            cwlMock.on(FilterLogEventsCommand).resolves({
                events: [
                    {
                        timestamp: new Date('2024-06-15T10:30:00Z').getTime(),
                        message: 'START RequestId: abc-123',
                    },
                    {
                        timestamp: new Date('2024-06-15T10:30:01Z').getTime(),
                        message: 'Processing event...',
                    },
                    {
                        timestamp: new Date('2024-06-15T10:30:02Z').getTime(),
                        message: 'END RequestId: abc-123',
                    },
                ],
            });

            const sub = findSub('logs');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'my-api-handler' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('START RequestId: abc-123');
            expect(text).toContain('Processing event...');
            expect(text).toContain('END RequestId: abc-123');
            expect(text).toContain('2024-06-15');
        });

        it('should return warning when no log events found', async () => {
            cwlMock.on(FilterLogEventsCommand).resolves({ events: [] });

            const sub = findSub('logs');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'my-api-handler' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No log events found');
        });

        it('should require a function name', async () => {
            const sub = findSub('logs');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Function name is required');
        });
    });
});
