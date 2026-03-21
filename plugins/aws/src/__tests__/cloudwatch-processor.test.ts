import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    CloudWatchClient,
    DescribeAlarmsCommand,
    ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { AwsCloudWatchProcessor } from '../processors/cloudwatch-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const cwMock = mockClient(CloudWatchClient);
const cwLogsMock = mockClient(CloudWatchLogsClient);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return {
        command: 'aws cloudwatch',
        rawCommand: 'aws cloudwatch',
        chainCommands: [],
        args: {},
        ...overrides,
    };
}

describe('AwsCloudWatchProcessor', () => {
    let processor: AwsCloudWatchProcessor;

    beforeEach(() => {
        cwMock.reset();
        cwLogsMock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        const credentialManager = new AwsCredentialManager(configService);
        processor = new AwsCloudWatchProcessor(credentialManager);
    });

    function findSub(name: string) {
        const sub = processor.processors!.find((p) => p.command === name);
        if (!sub) throw new Error(`Sub-processor "${name}" not found`);
        return sub;
    }

    // -------------------------------------------------------------------
    // alarms
    // -------------------------------------------------------------------
    describe('alarms', () => {
        it('should return table with alarm data', async () => {
            cwMock.on(DescribeAlarmsCommand).resolves({
                MetricAlarms: [
                    {
                        AlarmName: 'HighCPU',
                        StateValue: 'ALARM',
                        MetricName: 'CPUUtilization',
                        Namespace: 'AWS/EC2',
                    },
                    {
                        AlarmName: 'LowMemory',
                        StateValue: 'OK',
                        MetricName: 'MemoryUtilization',
                        Namespace: 'Custom/App',
                    },
                ],
            });

            const sub = findSub('alarms');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('HighCPU');
            expect(text).toContain('ALARM');
            expect(text).toContain('CPUUtilization');
            expect(text).toContain('AWS/EC2');
            expect(text).toContain('LowMemory');
            expect(text).toContain('OK');
        });

        it('should return warning when no alarms found', async () => {
            cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });

            const sub = findSub('alarms');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No alarms found');
        });

        it('should return error on failure', async () => {
            cwMock.on(DescribeAlarmsCommand).rejects(new Error('Access denied'));

            const sub = findSub('alarms');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Access denied');
        });
    });

    // -------------------------------------------------------------------
    // logs
    // -------------------------------------------------------------------
    describe('logs', () => {
        it('should return log events as text', async () => {
            cwLogsMock.on(FilterLogEventsCommand).resolves({
                events: [
                    { timestamp: 1700000000000, message: 'Hello world\n' },
                    { timestamp: 1700000060000, message: 'Another log line\n' },
                ],
            });

            const sub = findSub('logs');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: '/aws/lambda/my-function' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Hello world');
            expect(text).toContain('Another log line');
            // Timestamps should be ISO strings
            expect(text).toContain('2023-11-14');
        });

        it('should pass filter pattern and limit', async () => {
            cwLogsMock.on(FilterLogEventsCommand).resolves({ events: [] });

            const sub = findSub('logs');
            await sub.handleStructuredAsync!(
                makeCommand({
                    value: '/aws/lambda/my-function',
                    args: { filter: 'ERROR', limit: 10 },
                }),
            );

            const calls = cwLogsMock.commandCalls(FilterLogEventsCommand);
            expect(calls.length).toBe(1);
            const input = calls[0].args[0].input;
            expect(input.filterPattern).toBe('ERROR');
            expect(input.limit).toBe(10);
            expect(input.logGroupName).toBe('/aws/lambda/my-function');
        });

        it('should require a log group name', async () => {
            const sub = findSub('logs');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Log group name is required');
        });

        it('should return warning when no events found', async () => {
            cwLogsMock.on(FilterLogEventsCommand).resolves({ events: [] });

            const sub = findSub('logs');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: '/aws/lambda/my-function' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No log events found');
        });

        it('should return error on failure', async () => {
            cwLogsMock.on(FilterLogEventsCommand).rejects(new Error('ResourceNotFoundException'));

            const sub = findSub('logs');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: '/aws/lambda/does-not-exist' }),
            );

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('ResourceNotFoundException');
        });
    });

    // -------------------------------------------------------------------
    // metrics
    // -------------------------------------------------------------------
    describe('metrics', () => {
        it('should return table with metrics data', async () => {
            cwMock.on(ListMetricsCommand).resolves({
                Metrics: [
                    {
                        MetricName: 'CPUUtilization',
                        Dimensions: [
                            { Name: 'InstanceId', Value: 'i-1234567890abcdef0' },
                        ],
                    },
                    {
                        MetricName: 'NetworkIn',
                        Dimensions: [
                            { Name: 'InstanceId', Value: 'i-1234567890abcdef0' },
                            { Name: 'AutoScalingGroupName', Value: 'my-asg' },
                        ],
                    },
                ],
            });

            const sub = findSub('metrics');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'AWS/EC2' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('CPUUtilization');
            expect(text).toContain('InstanceId=i-1234567890abcdef0');
            expect(text).toContain('NetworkIn');
            expect(text).toContain('AutoScalingGroupName=my-asg');
        });

        it('should require a namespace', async () => {
            const sub = findSub('metrics');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Namespace is required');
        });

        it('should return warning when no metrics found', async () => {
            cwMock.on(ListMetricsCommand).resolves({ Metrics: [] });

            const sub = findSub('metrics');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'Custom/Empty' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No metrics found');
        });

        it('should pass namespace to ListMetricsCommand', async () => {
            cwMock.on(ListMetricsCommand).resolves({ Metrics: [] });

            const sub = findSub('metrics');
            await sub.handleStructuredAsync!(
                makeCommand({ value: 'AWS/EC2' }),
            );

            const calls = cwMock.commandCalls(ListMetricsCommand);
            expect(calls.length).toBe(1);
            expect(calls[0].args[0].input.Namespace).toBe('AWS/EC2');
        });

        it('should return error on failure', async () => {
            cwMock.on(ListMetricsCommand).rejects(new Error('Invalid namespace'));

            const sub = findSub('metrics');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'Bad/NS' }),
            );

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Invalid namespace');
        });
    });
});
