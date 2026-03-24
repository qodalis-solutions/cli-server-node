import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    EC2Client,
    DescribeInstancesCommand,
    StartInstancesCommand,
    StopInstancesCommand,
    RebootInstancesCommand,
    DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import { AwsEc2Processor } from '../processors/ec2-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const ec2Mock = mockClient(EC2Client);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return {
        command: 'aws ec2',
        rawCommand: 'aws ec2',
        chainCommands: [],
        args: {},
        ...overrides,
    };
}

describe('AwsEc2Processor', () => {
    let processor: AwsEc2Processor;
    let credentialManager: AwsCredentialManager;

    beforeEach(() => {
        ec2Mock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        credentialManager = new AwsCredentialManager(configService);
        processor = new AwsEc2Processor(credentialManager);
    });

    function findSub(name: string) {
        const sub = processor.processors!.find((p) => p.command === name);
        if (!sub) throw new Error(`Sub-processor "${name}" not found`);
        return sub;
    }

    function findNestedSub(parentName: string, childName: string) {
        const parent = findSub(parentName);
        const child = parent.processors!.find((p) => p.command === childName);
        if (!child) throw new Error(`Nested sub-processor "${parentName} ${childName}" not found`);
        return child;
    }

    // -------------------------------------------------------------------
    // list
    // -------------------------------------------------------------------
    describe('list', () => {
        it('should return table with instance data', async () => {
            ec2Mock.on(DescribeInstancesCommand).resolves({
                Reservations: [
                    {
                        Instances: [
                            {
                                InstanceId: 'i-0123456789abcdef0',
                                InstanceType: 't2.micro',
                                State: { Name: 'running' },
                                PublicIpAddress: '54.123.45.67',
                                Tags: [{ Key: 'Name', Value: 'my-web-server' }],
                            },
                            {
                                InstanceId: 'i-0abcdef1234567890',
                                InstanceType: 't3.small',
                                State: { Name: 'stopped' },
                                Tags: [{ Key: 'Env', Value: 'prod' }],
                            },
                        ],
                    },
                ],
            });

            const sub = findSub('list');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('i-0123456789abcdef0');
            expect(text).toContain('my-web-server');
            expect(text).toContain('running');
            expect(text).toContain('t2.micro');
            expect(text).toContain('54.123.45.67');
            expect(text).toContain('i-0abcdef1234567890');
            expect(text).toContain('stopped');
        });

        it('should return warning when no instances found', async () => {
            ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [] });

            const sub = findSub('list');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No instances found');
        });
    });

    // -------------------------------------------------------------------
    // describe
    // -------------------------------------------------------------------
    describe('describe', () => {
        it('should return key-value output for an instance', async () => {
            ec2Mock.on(DescribeInstancesCommand).resolves({
                Reservations: [
                    {
                        Instances: [
                            {
                                InstanceId: 'i-0123456789abcdef0',
                                InstanceType: 't2.micro',
                                State: { Name: 'running' },
                                Placement: { AvailabilityZone: 'us-east-1a' },
                                PublicIpAddress: '54.123.45.67',
                                PrivateIpAddress: '10.0.0.42',
                                LaunchTime: new Date('2024-06-15T10:30:00Z'),
                                SecurityGroups: [
                                    { GroupId: 'sg-abc123', GroupName: 'my-sg' },
                                ],
                                Tags: [{ Key: 'Name', Value: 'my-web-server' }],
                            },
                        ],
                    },
                ],
            });

            const sub = findSub('describe');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'i-0123456789abcdef0' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('i-0123456789abcdef0');
            expect(text).toContain('my-web-server');
            expect(text).toContain('running');
            expect(text).toContain('us-east-1a');
            expect(text).toContain('54.123.45.67');
            expect(text).toContain('10.0.0.42');
            expect(text).toContain('sg-abc123');
        });

        it('should require an instance ID', async () => {
            const sub = findSub('describe');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Instance ID is required');
        });
    });

    // -------------------------------------------------------------------
    // start
    // -------------------------------------------------------------------
    describe('start', () => {
        it('should return success message', async () => {
            ec2Mock.on(StartInstancesCommand).resolves({
                StartingInstances: [
                    {
                        InstanceId: 'i-0123456789abcdef0',
                        CurrentState: { Name: 'pending' },
                        PreviousState: { Name: 'stopped' },
                    },
                ],
            });

            const sub = findSub('start');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'i-0123456789abcdef0' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Starting instance i-0123456789abcdef0');
        });

        it('should require an instance ID', async () => {
            const sub = findSub('start');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
        });
    });

    // -------------------------------------------------------------------
    // stop
    // -------------------------------------------------------------------
    describe('stop', () => {
        it('should stop an instance', async () => {
            ec2Mock.on(StopInstancesCommand).resolves({
                StoppingInstances: [
                    {
                        InstanceId: 'i-0123456789abcdef0',
                        CurrentState: { Name: 'stopping' },
                        PreviousState: { Name: 'running' },
                    },
                ],
            });

            const sub = findSub('stop');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'i-0123456789abcdef0' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Stopping instance i-0123456789abcdef0');
        });

        it('should support dry-run', async () => {
            const sub = findSub('stop');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'i-0123456789abcdef0', args: { 'dry-run': true } }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('DRY RUN');
            expect(text).toContain('i-0123456789abcdef0');

            expect(ec2Mock.commandCalls(StopInstancesCommand).length).toBe(0);
        });
    });

    // -------------------------------------------------------------------
    // reboot
    // -------------------------------------------------------------------
    describe('reboot', () => {
        it('should reboot an instance', async () => {
            ec2Mock.on(RebootInstancesCommand).resolves({});

            const sub = findSub('reboot');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'i-0123456789abcdef0' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Rebooting instance i-0123456789abcdef0');
        });

        it('should support dry-run', async () => {
            const sub = findSub('reboot');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'i-0123456789abcdef0', args: { 'dry-run': true } }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('DRY RUN');

            expect(ec2Mock.commandCalls(RebootInstancesCommand).length).toBe(0);
        });
    });

    // -------------------------------------------------------------------
    // sg list
    // -------------------------------------------------------------------
    describe('sg list', () => {
        it('should return table with security groups', async () => {
            ec2Mock.on(DescribeSecurityGroupsCommand).resolves({
                SecurityGroups: [
                    {
                        GroupId: 'sg-abc123',
                        GroupName: 'my-sg',
                        VpcId: 'vpc-12345',
                        Description: 'My security group',
                    },
                    {
                        GroupId: 'sg-def456',
                        GroupName: 'default',
                        VpcId: 'vpc-12345',
                        Description: 'Default security group',
                    },
                ],
            });

            const sub = findNestedSub('sg', 'list');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('sg-abc123');
            expect(text).toContain('my-sg');
            expect(text).toContain('vpc-12345');
            expect(text).toContain('My security group');
            expect(text).toContain('sg-def456');
        });

        it('should return warning when no security groups found', async () => {
            ec2Mock.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });

            const sub = findNestedSub('sg', 'list');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No security groups found');
        });
    });
});
