import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import {
    ECSClient,
    ListClustersCommand,
    DescribeClustersCommand,
    ListServicesCommand,
    DescribeServicesCommand,
    ListTasksCommand,
    DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    formatAsTable,
    applyOutputFormat,
} from '../utils/output-helpers';

// ---------------------------------------------------------------------------
// ecs clusters
// ---------------------------------------------------------------------------

class EcsClustersProcessor extends CliCommandProcessor {
    command = 'clusters';
    description = 'List ECS clusters';
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
        const client = this.credentialManager.getClient(ECSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const listResponse = await client.send(new ListClustersCommand({}));
            const clusterArns = listResponse.clusterArns ?? [];

            if (clusterArns.length === 0) {
                return buildResponse([{ type: 'text', value: 'No ECS clusters found.', style: 'warning' }]);
            }

            const describeResponse = await client.send(new DescribeClustersCommand({ clusters: clusterArns }));
            const clusters = describeResponse.clusters ?? [];

            const rows = clusters.map((cluster) => [
                cluster.clusterName ?? '(unknown)',
                cluster.status ?? '(unknown)',
                String(cluster.runningTasksCount ?? 0),
                String(cluster.pendingTasksCount ?? 0),
            ]);

            const tableOutput = formatAsTable(
                ['Cluster Name', 'Status', 'Running Tasks', 'Pending Tasks'],
                rows,
            );
            return buildResponse([applyOutputFormat(command, tableOutput, clusters)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list ECS clusters: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ecs services
// ---------------------------------------------------------------------------

class EcsServicesProcessor extends CliCommandProcessor {
    command = 'services';
    description = 'List ECS services in a cluster';
    valueRequired = true;
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
        const cluster = command.value?.trim();
        if (!cluster) {
            return buildErrorResponse('Cluster name or ARN is required. Usage: ecs services <cluster>');
        }

        const client = this.credentialManager.getClient(ECSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const listResponse = await client.send(new ListServicesCommand({ cluster }));
            const serviceArns = listResponse.serviceArns ?? [];

            if (serviceArns.length === 0) {
                return buildResponse([{ type: 'text', value: `No ECS services found in cluster "${cluster}".`, style: 'warning' }]);
            }

            const describeResponse = await client.send(new DescribeServicesCommand({ cluster, services: serviceArns }));
            const services = describeResponse.services ?? [];

            const rows = services.map((service) => [
                service.serviceName ?? '(unknown)',
                service.status ?? '(unknown)',
                String(service.desiredCount ?? 0),
                String(service.runningCount ?? 0),
                String(service.pendingCount ?? 0),
            ]);

            const tableOutput = formatAsTable(
                ['Service Name', 'Status', 'Desired', 'Running', 'Pending'],
                rows,
            );
            return buildResponse([applyOutputFormat(command, tableOutput, services)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list ECS services: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ecs tasks
// ---------------------------------------------------------------------------

class EcsTasksProcessor extends CliCommandProcessor {
    command = 'tasks';
    description = 'List ECS tasks in a cluster';
    valueRequired = true;
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
        const cluster = command.value?.trim();
        if (!cluster) {
            return buildErrorResponse('Cluster name or ARN is required. Usage: ecs tasks <cluster>');
        }

        const client = this.credentialManager.getClient(ECSClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const listResponse = await client.send(new ListTasksCommand({ cluster }));
            const taskArns = listResponse.taskArns ?? [];

            if (taskArns.length === 0) {
                return buildResponse([{ type: 'text', value: `No ECS tasks found in cluster "${cluster}".`, style: 'warning' }]);
            }

            const describeResponse = await client.send(new DescribeTasksCommand({ cluster, tasks: taskArns }));
            const tasks = describeResponse.tasks ?? [];

            const rows = tasks.map((task) => [
                task.taskArn?.split('/').pop() ?? '(unknown)',
                task.lastStatus ?? '(unknown)',
                task.taskDefinitionArn?.split('/').pop() ?? '(unknown)',
                task.startedAt ? task.startedAt.toISOString().slice(0, 19).replace('T', ' ') : '(not started)',
            ]);

            const tableOutput = formatAsTable(
                ['Task ID', 'Status', 'Definition', 'Started'],
                rows,
            );
            return buildResponse([applyOutputFormat(command, tableOutput, tasks)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list ECS tasks: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ecs (parent)
// ---------------------------------------------------------------------------

export class AwsEcsProcessor extends CliCommandProcessor {
    command = 'ecs';
    description = 'AWS ECS operations — clusters, services, tasks';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new EcsClustersProcessor(credentialManager),
            new EcsServicesProcessor(credentialManager),
            new EcsTasksProcessor(credentialManager),
        ];
    }

    async handleAsync(): Promise<string> {
        return '';
    }
}
