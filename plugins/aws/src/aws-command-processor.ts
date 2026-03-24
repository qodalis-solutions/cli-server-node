import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    CliStructuredResponse,
    ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import { AwsConfigService } from './services/aws-config-service';
import { AwsCredentialManager } from './services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    buildSuccessResponse,
    formatAsKeyValue,
    formatAsList,
} from './utils/output-helpers';

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { AwsS3Processor } from './processors/s3-processor';
import { AwsEc2Processor } from './processors/ec2-processor';
import { AwsLambdaProcessor } from './processors/lambda-processor';
import { AwsCloudWatchProcessor } from './processors/cloudwatch-processor';
import { AwsSnsProcessor } from './processors/sns-processor';
import { AwsSqsProcessor } from './processors/sqs-processor';
import { AwsIamProcessor } from './processors/iam-processor';
import { AwsEcsProcessor } from './processors/ecs-processor';
import { AwsDynamoDbProcessor } from './processors/dynamodb-processor';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Sub-processor that sets AWS credentials, region, and profile via `aws configure set`. */
class AwsConfigureSetProcessor extends CliCommandProcessor {
    command = 'set';
    description = 'Set AWS credentials and region';
    parameters = [
        new CliCommandParameterDescriptor('key', 'AWS access key ID', false, 'string', ['-k']),
        new CliCommandParameterDescriptor('secret', 'AWS secret access key', false, 'string', ['-s']),
        new CliCommandParameterDescriptor('region', 'AWS region', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('profile', 'AWS profile name', false, 'string', ['-p'], 'default'),
    ];

    constructor(
        private readonly configService: AwsConfigService,
        private readonly credentialManager: AwsCredentialManager,
    ) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const key = command.args?.key as string | undefined;
        const secret = command.args?.secret as string | undefined;
        const region = command.args?.region as string | undefined;
        const profile = command.args?.profile as string | undefined;

        if (key && secret) {
            this.configService.setCredentials(key, secret);
            this.credentialManager.clearCache();
        } else if (key || secret) {
            return buildErrorResponse('Both --key and --secret must be provided together.');
        }

        if (region) {
            this.configService.setRegion(region);
            this.credentialManager.clearCache();
        }

        if (profile) {
            this.configService.setProfile(profile);
            this.credentialManager.clearCache();
        }

        if (!key && !secret && !region && !profile) {
            return buildErrorResponse('Provide at least one of --key/--secret, --region, or --profile.');
        }

        return buildSuccessResponse('AWS configuration updated.');
    }
}

/** Sub-processor that displays the current AWS configuration (secrets masked) via `aws configure get`. */
class AwsConfigureGetProcessor extends CliCommandProcessor {
    command = 'get';
    description = 'Show current AWS configuration (secrets masked)';

    constructor(private readonly configService: AwsConfigService) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(): Promise<CliStructuredResponse> {
        const summary = this.configService.getConfigSummary();
        const entries: Record<string, string> = {};
        entries['Access Key ID'] = summary.accessKeyId ?? '(not set)';
        entries['Secret Access Key'] = summary.secretAccessKey ?? '(not set)';
        entries['Region'] = summary.region ?? '(not set)';
        entries['Profile'] = summary.profile ?? 'default';
        return buildResponse([formatAsKeyValue(entries)]);
    }
}

/** Sub-processor that lists available AWS profiles from ~/.aws/credentials and ~/.aws/config. */
class AwsConfigureProfilesProcessor extends CliCommandProcessor {
    command = 'profiles';
    description = 'List available AWS profiles from ~/.aws/credentials and ~/.aws/config';

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(): Promise<CliStructuredResponse> {
        const profiles = new Set<string>();

        const credentialsPath = path.join(os.homedir(), '.aws', 'credentials');
        const configPath = path.join(os.homedir(), '.aws', 'config');

        this.parseProfiles(credentialsPath, /^\[([^\]]+)\]/, profiles);
        this.parseProfiles(configPath, /^\[(?:profile\s+)?([^\]]+)\]/, profiles);

        const items = Array.from(profiles).sort();

        if (items.length === 0) {
            return buildResponse([
                { type: 'text', value: 'No AWS profiles found in ~/.aws/credentials or ~/.aws/config.', style: 'warning' },
            ]);
        }

        return buildResponse([formatAsList(items)]);
    }

    /**
     * Parses profile names from an AWS configuration file.
     * @param filePath - Path to the AWS credentials or config file.
     * @param pattern - Regex to match section headers and capture profile names.
     * @param profiles - Set to add discovered profile names to.
     */
    private parseProfiles(filePath: string, pattern: RegExp, profiles: Set<string>): void {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            for (const line of content.split('\n')) {
                const match = line.trim().match(pattern);
                if (match) {
                    profiles.add(match[1].trim());
                }
            }
        } catch {
            // File doesn't exist or is unreadable
        }
    }
}

/** Parent processor for `aws configure` sub-commands (set, get, profiles). */
class AwsConfigureProcessor extends CliCommandProcessor {
    command = 'configure';
    description = 'Manage AWS credentials and configuration';
    processors: ICliCommandProcessor[];

    constructor(configService: AwsConfigService, credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new AwsConfigureSetProcessor(configService, credentialManager),
            new AwsConfigureGetProcessor(configService),
            new AwsConfigureProfilesProcessor(),
        ];
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }
}

/** Sub-processor that tests AWS connectivity via STS GetCallerIdentity. */
class AwsStatusProcessor extends CliCommandProcessor {
    command = 'status';
    description = 'Test AWS connectivity using STS GetCallerIdentity';

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }

    /** @inheritdoc */
    async handleStructuredAsync(): Promise<CliStructuredResponse> {
        try {
            const client = this.credentialManager.getClient(STSClient);
            const response = await client.send(new GetCallerIdentityCommand({}));

            const entries: Record<string, string> = {
                Account: response.Account ?? '(unknown)',
                Arn: response.Arn ?? '(unknown)',
                UserId: response.UserId ?? '(unknown)',
            };

            return buildResponse([
                { type: 'text', value: 'AWS connection successful.', style: 'success' },
                formatAsKeyValue(entries),
            ]);
        } catch (err: any) {
            if (
                err.name === 'CredentialsProviderError' ||
                err.name === 'NoSuchKey' ||
                err.message?.includes('Could not load credentials')
            ) {
                return buildErrorResponse(
                    'No AWS credentials configured. Run "aws configure set --key <key> --secret <secret>" or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables.',
                );
            }
            return buildErrorResponse(`AWS status check failed: ${err.message ?? err}`);
        }
    }
}

/** Root processor for all AWS CLI commands, providing access to service-specific sub-processors. */
export class AwsCommandProcessor extends CliCommandProcessor {
    command = 'aws';
    description = 'AWS cloud resource management';
    processors: ICliCommandProcessor[];

    private readonly configService: AwsConfigService;
    private readonly credentialManager: AwsCredentialManager;

    constructor() {
        super();
        this.configService = new AwsConfigService();
        this.credentialManager = new AwsCredentialManager(this.configService);
        this.processors = [
            new AwsConfigureProcessor(this.configService, this.credentialManager),
            new AwsStatusProcessor(this.credentialManager),
            new AwsS3Processor(this.credentialManager),
            new AwsEc2Processor(this.credentialManager),
            new AwsLambdaProcessor(this.credentialManager),
            new AwsCloudWatchProcessor(this.credentialManager),
            new AwsSnsProcessor(this.credentialManager),
            new AwsSqsProcessor(this.credentialManager),
            new AwsEcsProcessor(this.credentialManager),
            new AwsDynamoDbProcessor(this.credentialManager),
            new AwsIamProcessor(this.credentialManager),
        ];
    }

    /** Returns the credential manager used by all sub-processors. */
    getCredentialManager(): AwsCredentialManager {
        return this.credentialManager;
    }

    /** Returns the configuration service used by all sub-processors. */
    getConfigService(): AwsConfigService {
        return this.configService;
    }

    /** @inheritdoc */
    async handleAsync(): Promise<string> {
        return '';
    }
}
