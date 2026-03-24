import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import {
    CloudWatchClient,
    DescribeAlarmsCommand,
    ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    formatAsTable,
    applyOutputFormat,
} from '../utils/output-helpers';

/** Sub-processor that lists CloudWatch alarms. */
class CloudWatchAlarmsProcessor extends CliCommandProcessor {
    command = 'alarms';
    description = 'List CloudWatch alarms';
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('output', 'Output format (table|json|text)', false, 'string', ['-o'], 'table'),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const client = this.credentialManager.getClient(CloudWatchClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new DescribeAlarmsCommand({}));
            const alarms = response.MetricAlarms ?? [];

            if (alarms.length === 0) {
                return buildResponse([{ type: 'text', value: 'No alarms found.', style: 'warning' }]);
            }

            const rows = alarms.map((a) => [
                a.AlarmName ?? '(unknown)',
                a.StateValue ?? '(unknown)',
                a.MetricName ?? '(unknown)',
                a.Namespace ?? '(unknown)',
            ]);

            const tableOutput = formatAsTable(['Name', 'State', 'Metric', 'Namespace'], rows);
            return buildResponse([applyOutputFormat(command, tableOutput, alarms)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list alarms: ${err.message ?? err}`);
        }
    }
}

/** Sub-processor that fetches log events from a CloudWatch log group. */
class CloudWatchLogsProcessor extends CliCommandProcessor {
    command = 'logs';
    description = 'Fetch log events from a CloudWatch log group';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('filter', 'Filter pattern for log events', false, 'string', ['-f']),
        new CliCommandParameterDescriptor('limit', 'Maximum number of events to return (default: 50)', false, 'number', ['-l'], '50'),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const logGroupName = command.value?.trim();
        if (!logGroupName) {
            return buildErrorResponse('Log group name is required. Usage: cloudwatch logs <log-group>');
        }

        const client = this.credentialManager.getClient(CloudWatchLogsClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        const limit = command.args?.limit ? Number(command.args.limit) : 50;
        const filterPattern = command.args?.filter ? String(command.args.filter) : undefined;

        try {
            const response = await client.send(
                new FilterLogEventsCommand({
                    logGroupName,
                    filterPattern,
                    limit,
                }),
            );

            const events = response.events ?? [];

            if (events.length === 0) {
                return buildResponse([{ type: 'text', value: 'No log events found.', style: 'warning' }]);
            }

            const lines = events.map((e) => {
                const timestamp = e.timestamp ? new Date(e.timestamp).toISOString() : '(unknown)';
                const message = e.message?.trimEnd() ?? '';
                return `${timestamp} ${message}`;
            });

            return buildResponse([{ type: 'text', value: lines.join('\n') }]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to fetch log events: ${err.message ?? err}`);
        }
    }
}

/** Sub-processor that lists CloudWatch metrics for a given namespace. */
class CloudWatchMetricsProcessor extends CliCommandProcessor {
    command = 'metrics';
    description = 'List CloudWatch metrics for a namespace';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('output', 'Output format (table|json|text)', false, 'string', ['-o'], 'table'),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const namespace = command.value?.trim();
        if (!namespace) {
            return buildErrorResponse('Namespace is required. Usage: cloudwatch metrics <namespace>');
        }

        const client = this.credentialManager.getClient(CloudWatchClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(
                new ListMetricsCommand({ Namespace: namespace }),
            );

            const metrics = response.Metrics ?? [];

            if (metrics.length === 0) {
                return buildResponse([{ type: 'text', value: `No metrics found for namespace "${namespace}".`, style: 'warning' }]);
            }

            const rows = metrics.map((m) => {
                const dims = (m.Dimensions ?? [])
                    .map((d) => `${d.Name}=${d.Value}`)
                    .join(', ');
                return [m.MetricName ?? '(unknown)', dims];
            });

            const tableOutput = formatAsTable(['MetricName', 'Dimensions'], rows);
            return buildResponse([applyOutputFormat(command, tableOutput, metrics)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list metrics: ${err.message ?? err}`);
        }
    }
}

/** Parent processor for CloudWatch sub-commands (alarms, logs, metrics). */
export class AwsCloudWatchProcessor extends CliCommandProcessor {
    command = 'cloudwatch';
    description = 'Amazon CloudWatch — alarms, logs, and metrics';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new CloudWatchAlarmsProcessor(credentialManager),
            new CloudWatchLogsProcessor(credentialManager),
            new CloudWatchMetricsProcessor(credentialManager),
        ];
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }
}
