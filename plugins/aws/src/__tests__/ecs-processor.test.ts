import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    ECSClient,
    ListClustersCommand,
    DescribeClustersCommand,
    ListServicesCommand,
    DescribeServicesCommand,
    ListTasksCommand,
    DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { AwsEcsProcessor } from '../processors/ecs-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const ecsMock = mockClient(ECSClient);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return { command: 'aws ecs', rawCommand: 'aws ecs', chainCommands: [], args: {}, ...overrides };
}

describe('AwsEcsProcessor', () => {
    let processor: AwsEcsProcessor;
    let credentialManager: AwsCredentialManager;

    beforeEach(() => {
        ecsMock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        credentialManager = new AwsCredentialManager(configService);
        processor = new AwsEcsProcessor(credentialManager);
    });

    function findSub(name: string) {
        const sub = processor.processors!.find((p) => p.command === name);
        if (!sub) throw new Error(`Sub-processor "${name}" not found`);
        return sub;
    }

    // -------------------------------------------------------------------
    // clusters
    // -------------------------------------------------------------------
    describe('clusters', () => {
        it('should return table with cluster details', async () => {
            ecsMock.on(ListClustersCommand).resolves({
                clusterArns: [
                    'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
                    'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster',
                ],
            });

            ecsMock.on(DescribeClustersCommand).resolves({
                clusters: [
                    {
                        clusterName: 'my-cluster',
                        status: 'ACTIVE',
                        runningTasksCount: 3,
                        pendingTasksCount: 0,
                    },
                    {
                        clusterName: 'prod-cluster',
                        status: 'ACTIVE',
                        runningTasksCount: 10,
                        pendingTasksCount: 2,
                    },
                ],
            });

            const sub = findSub('clusters');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('my-cluster');
            expect(text).toContain('prod-cluster');
            expect(text).toContain('ACTIVE');
        });

        it('should return warning when no clusters found', async () => {
            ecsMock.on(ListClustersCommand).resolves({ clusterArns: [] });

            const sub = findSub('clusters');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No ECS clusters found');
        });
    });

    // -------------------------------------------------------------------
    // services
    // -------------------------------------------------------------------
    describe('services', () => {
        it('should return table with service details', async () => {
            ecsMock.on(ListServicesCommand).resolves({
                serviceArns: [
                    'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
                ],
            });

            ecsMock.on(DescribeServicesCommand).resolves({
                services: [
                    {
                        serviceName: 'my-service',
                        status: 'ACTIVE',
                        desiredCount: 2,
                        runningCount: 2,
                        pendingCount: 0,
                    },
                ],
            });

            const sub = findSub('services');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'my-cluster' }));

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('my-service');
            expect(text).toContain('ACTIVE');
        });

        it('should return error when cluster is missing', async () => {
            const sub = findSub('services');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Cluster name or ARN is required');
        });

        it('should return warning when no services found', async () => {
            ecsMock.on(ListServicesCommand).resolves({ serviceArns: [] });

            const sub = findSub('services');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'my-cluster' }));

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No ECS services found');
        });
    });

    // -------------------------------------------------------------------
    // tasks
    // -------------------------------------------------------------------
    describe('tasks', () => {
        it('should return table with task details', async () => {
            const startedAt = new Date('2024-01-15T10:30:00Z');

            ecsMock.on(ListTasksCommand).resolves({
                taskArns: [
                    'arn:aws:ecs:us-east-1:123456789012:task/my-cluster/abc123def456',
                ],
            });

            ecsMock.on(DescribeTasksCommand).resolves({
                tasks: [
                    {
                        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/my-cluster/abc123def456',
                        lastStatus: 'RUNNING',
                        taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
                        startedAt,
                    },
                ],
            });

            const sub = findSub('tasks');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'my-cluster' }));

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('abc123def456');
            expect(text).toContain('RUNNING');
            expect(text).toContain('my-task:1');
            expect(text).toContain('2024-01-15');
        });

        it('should return error when cluster is missing', async () => {
            const sub = findSub('tasks');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Cluster name or ARN is required');
        });

        it('should return warning when no tasks found', async () => {
            ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });

            const sub = findSub('tasks');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'my-cluster' }));

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No ECS tasks found');
        });
    });
});
