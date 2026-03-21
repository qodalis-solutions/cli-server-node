import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import {
    EC2Client,
    DescribeInstancesCommand,
    StartInstancesCommand,
    StopInstancesCommand,
    RebootInstancesCommand,
    DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    buildSuccessResponse,
    formatAsTable,
    formatAsKeyValue,
    applyOutputFormat,
    isDryRun,
} from '../utils/output-helpers';

// ---------------------------------------------------------------------------
// ec2 list
// ---------------------------------------------------------------------------

class Ec2ListProcessor extends CliCommandProcessor {
    command = 'list';
    description = 'List all EC2 instances';
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
        const client = this.credentialManager.getClient(EC2Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new DescribeInstancesCommand({}));
            const instances = (response.Reservations ?? []).flatMap((r) => r.Instances ?? []);

            if (instances.length === 0) {
                return buildResponse([{ type: 'text', value: 'No instances found.', style: 'warning' }]);
            }

            const rows = instances.map((inst) => {
                const nameTag = inst.Tags?.find((t) => t.Key === 'Name');
                return [
                    inst.InstanceId ?? '(unknown)',
                    nameTag?.Value ?? '(none)',
                    inst.State?.Name ?? '(unknown)',
                    inst.InstanceType ?? '(unknown)',
                    inst.PublicIpAddress ?? '(none)',
                ];
            });

            const tableOutput = formatAsTable(
                ['Instance ID', 'Name', 'State', 'Type', 'Public IP'],
                rows,
            );
            return buildResponse([applyOutputFormat(command, tableOutput, instances)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list instances: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ec2 describe
// ---------------------------------------------------------------------------

class Ec2DescribeProcessor extends CliCommandProcessor {
    command = 'describe';
    description = 'Describe an EC2 instance';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const instanceId = command.value?.trim();
        if (!instanceId) {
            return buildErrorResponse('Instance ID is required. Usage: ec2 describe <instance-id>');
        }

        const client = this.credentialManager.getClient(EC2Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(
                new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
            );
            const instances = (response.Reservations ?? []).flatMap((r) => r.Instances ?? []);

            if (instances.length === 0) {
                return buildErrorResponse(`Instance "${instanceId}" not found.`);
            }

            const inst = instances[0];
            const nameTag = inst.Tags?.find((t) => t.Key === 'Name');
            const sgList = (inst.SecurityGroups ?? [])
                .map((sg) => `${sg.GroupId} (${sg.GroupName})`)
                .join(', ') || '(none)';

            const entries: Record<string, string> = {
                'Instance ID': inst.InstanceId ?? '(unknown)',
                'Name': nameTag?.Value ?? '(none)',
                'State': inst.State?.Name ?? '(unknown)',
                'Type': inst.InstanceType ?? '(unknown)',
                'Availability Zone': inst.Placement?.AvailabilityZone ?? '(unknown)',
                'Public IP': inst.PublicIpAddress ?? '(none)',
                'Private IP': inst.PrivateIpAddress ?? '(none)',
                'Launch Time': inst.LaunchTime ? inst.LaunchTime.toISOString() : '(unknown)',
                'Security Groups': sgList,
            };

            return buildResponse([formatAsKeyValue(entries)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to describe instance: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ec2 start
// ---------------------------------------------------------------------------

class Ec2StartProcessor extends CliCommandProcessor {
    command = 'start';
    description = 'Start an EC2 instance';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const instanceId = command.value?.trim();
        if (!instanceId) {
            return buildErrorResponse('Instance ID is required. Usage: ec2 start <instance-id>');
        }

        const client = this.credentialManager.getClient(EC2Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
            return buildSuccessResponse(`Starting instance ${instanceId}... done`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to start instance: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ec2 stop
// ---------------------------------------------------------------------------

class Ec2StopProcessor extends CliCommandProcessor {
    command = 'stop';
    description = 'Stop an EC2 instance';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('dry-run', 'Preview without stopping', false, 'boolean'),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const instanceId = command.value?.trim();
        if (!instanceId) {
            return buildErrorResponse('Instance ID is required. Usage: ec2 stop <instance-id>');
        }

        if (isDryRun(command)) {
            return buildResponse([
                { type: 'text', value: `[DRY RUN] Would stop instance ${instanceId}`, style: 'warning' },
            ]);
        }

        const client = this.credentialManager.getClient(EC2Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
            return buildSuccessResponse(`Stopping instance ${instanceId}... done`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to stop instance: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ec2 reboot
// ---------------------------------------------------------------------------

class Ec2RebootProcessor extends CliCommandProcessor {
    command = 'reboot';
    description = 'Reboot an EC2 instance';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('dry-run', 'Preview without rebooting', false, 'boolean'),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const instanceId = command.value?.trim();
        if (!instanceId) {
            return buildErrorResponse('Instance ID is required. Usage: ec2 reboot <instance-id>');
        }

        if (isDryRun(command)) {
            return buildResponse([
                { type: 'text', value: `[DRY RUN] Would reboot instance ${instanceId}`, style: 'warning' },
            ]);
        }

        const client = this.credentialManager.getClient(EC2Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            await client.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
            return buildSuccessResponse(`Rebooting instance ${instanceId}... done`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to reboot instance: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ec2 sg list
// ---------------------------------------------------------------------------

class Ec2SgListProcessor extends CliCommandProcessor {
    command = 'list';
    description = 'List all security groups';
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
        const client = this.credentialManager.getClient(EC2Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new DescribeSecurityGroupsCommand({}));
            const groups = response.SecurityGroups ?? [];

            if (groups.length === 0) {
                return buildResponse([{ type: 'text', value: 'No security groups found.', style: 'warning' }]);
            }

            const rows = groups.map((sg) => [
                sg.GroupId ?? '(unknown)',
                sg.GroupName ?? '(unknown)',
                sg.VpcId ?? '(none)',
                sg.Description ?? '(none)',
            ]);

            const tableOutput = formatAsTable(
                ['Group ID', 'Group Name', 'VPC ID', 'Description'],
                rows,
            );
            return buildResponse([applyOutputFormat(command, tableOutput, groups)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list security groups: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// ec2 sg (parent)
// ---------------------------------------------------------------------------

class Ec2SgProcessor extends CliCommandProcessor {
    command = 'sg';
    description = 'EC2 security group operations';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new Ec2SgListProcessor(credentialManager),
        ];
    }

    async handleAsync(): Promise<string> {
        return '';
    }
}

// ---------------------------------------------------------------------------
// ec2 (parent)
// ---------------------------------------------------------------------------

export class AwsEc2Processor extends CliCommandProcessor {
    command = 'ec2';
    description = 'Amazon EC2 operations — manage instances and security groups';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new Ec2ListProcessor(credentialManager),
            new Ec2DescribeProcessor(credentialManager),
            new Ec2StartProcessor(credentialManager),
            new Ec2StopProcessor(credentialManager),
            new Ec2RebootProcessor(credentialManager),
            new Ec2SgProcessor(credentialManager),
        ];
    }

    async handleAsync(): Promise<string> {
        return '';
    }
}
