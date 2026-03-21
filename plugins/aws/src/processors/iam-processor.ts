import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import { IAMClient, ListUsersCommand, ListRolesCommand, ListPoliciesCommand } from '@aws-sdk/client-iam';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    formatAsTable,
    applyOutputFormat,
} from '../utils/output-helpers';

// ---------------------------------------------------------------------------
// iam users
// ---------------------------------------------------------------------------

class IamUsersProcessor extends CliCommandProcessor {
    command = 'users';
    description = 'List IAM users';
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
        const client = this.credentialManager.getClient(IAMClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new ListUsersCommand({}));
            const users = response.Users ?? [];

            if (users.length === 0) {
                return buildResponse([{ type: 'text', value: 'No IAM users found.', style: 'warning' }]);
            }

            const rows = users.map((user) => [
                user.UserName ?? '(unknown)',
                user.UserId ?? '(unknown)',
                user.Arn ?? '(unknown)',
                user.CreateDate ? user.CreateDate.toISOString().slice(0, 10) : '(unknown)',
            ]);

            const tableOutput = formatAsTable(
                ['UserName', 'UserId', 'Arn', 'CreateDate'],
                rows,
            );
            return buildResponse([applyOutputFormat(command, tableOutput, users)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list IAM users: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// iam roles
// ---------------------------------------------------------------------------

class IamRolesProcessor extends CliCommandProcessor {
    command = 'roles';
    description = 'List IAM roles';
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
        const client = this.credentialManager.getClient(IAMClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new ListRolesCommand({}));
            const roles = response.Roles ?? [];

            if (roles.length === 0) {
                return buildResponse([{ type: 'text', value: 'No IAM roles found.', style: 'warning' }]);
            }

            const rows = roles.map((role) => [
                role.RoleName ?? '(unknown)',
                role.RoleId ?? '(unknown)',
                role.Arn ?? '(unknown)',
                role.CreateDate ? role.CreateDate.toISOString().slice(0, 10) : '(unknown)',
            ]);

            const tableOutput = formatAsTable(
                ['RoleName', 'RoleId', 'Arn', 'CreateDate'],
                rows,
            );
            return buildResponse([applyOutputFormat(command, tableOutput, roles)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list IAM roles: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// iam policies
// ---------------------------------------------------------------------------

class IamPoliciesProcessor extends CliCommandProcessor {
    command = 'policies';
    description = 'List IAM policies (local/customer-managed)';
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
        const client = this.credentialManager.getClient(IAMClient, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const response = await client.send(new ListPoliciesCommand({ Scope: 'Local' }));
            const policies = response.Policies ?? [];

            if (policies.length === 0) {
                return buildResponse([{ type: 'text', value: 'No IAM policies found.', style: 'warning' }]);
            }

            const rows = policies.map((policy) => [
                policy.PolicyName ?? '(unknown)',
                policy.Arn ?? '(unknown)',
                String(policy.AttachmentCount ?? 0),
            ]);

            const tableOutput = formatAsTable(
                ['PolicyName', 'Arn', 'AttachmentCount'],
                rows,
            );
            return buildResponse([applyOutputFormat(command, tableOutput, policies)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list IAM policies: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// iam (parent)
// ---------------------------------------------------------------------------

export class AwsIamProcessor extends CliCommandProcessor {
    command = 'iam';
    description = 'AWS IAM operations — users, roles, policies';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new IamUsersProcessor(credentialManager),
            new IamRolesProcessor(credentialManager),
            new IamPoliciesProcessor(credentialManager),
        ];
    }

    async handleAsync(): Promise<string> {
        return '';
    }
}
