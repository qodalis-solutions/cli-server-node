import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { IAMClient, ListUsersCommand, ListRolesCommand, ListPoliciesCommand } from '@aws-sdk/client-iam';
import { AwsIamProcessor } from '../processors/iam-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const iamMock = mockClient(IAMClient);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return { command: 'aws iam', rawCommand: 'aws iam', chainCommands: [], args: {}, ...overrides };
}

describe('AwsIamProcessor', () => {
    let processor: AwsIamProcessor;
    let credentialManager: AwsCredentialManager;

    beforeEach(() => {
        iamMock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        credentialManager = new AwsCredentialManager(configService);
        processor = new AwsIamProcessor(credentialManager);
    });

    function findSub(name: string) {
        const sub = processor.processors!.find((p) => p.command === name);
        if (!sub) throw new Error(`Sub-processor "${name}" not found`);
        return sub;
    }

    // -------------------------------------------------------------------
    // users
    // -------------------------------------------------------------------
    describe('users', () => {
        it('should return table of IAM users', async () => {
            iamMock.on(ListUsersCommand).resolves({
                Users: [
                    {
                        UserName: 'alice',
                        UserId: 'AIDACKCEVSQ6C2EXAMPLE',
                        Arn: 'arn:aws:iam::123456789012:user/alice',
                        CreateDate: new Date('2022-01-15T10:00:00Z'),
                        Path: '/',
                    },
                    {
                        UserName: 'bob',
                        UserId: 'AIDACKCEVSQ6C3EXAMPLE',
                        Arn: 'arn:aws:iam::123456789012:user/bob',
                        CreateDate: new Date('2023-06-20T08:30:00Z'),
                        Path: '/',
                    },
                ],
            });

            const sub = findSub('users');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('alice');
            expect(text).toContain('bob');
            expect(text).toContain('AIDACKCEVSQ6C2EXAMPLE');
            expect(text).toContain('2022-01-15');
        });

        it('should return warning when no users found', async () => {
            iamMock.on(ListUsersCommand).resolves({ Users: [] });

            const sub = findSub('users');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No IAM users found');
        });
    });

    // -------------------------------------------------------------------
    // roles
    // -------------------------------------------------------------------
    describe('roles', () => {
        it('should return table of IAM roles', async () => {
            iamMock.on(ListRolesCommand).resolves({
                Roles: [
                    {
                        RoleName: 'AdminRole',
                        RoleId: 'AROACKCEVSQ6C2EXAMPLE',
                        Arn: 'arn:aws:iam::123456789012:role/AdminRole',
                        CreateDate: new Date('2021-03-10T12:00:00Z'),
                        Path: '/',
                        AssumeRolePolicyDocument: '{}',
                    },
                    {
                        RoleName: 'ReadOnlyRole',
                        RoleId: 'AROACKCEVSQ6C3EXAMPLE',
                        Arn: 'arn:aws:iam::123456789012:role/ReadOnlyRole',
                        CreateDate: new Date('2022-07-25T09:00:00Z'),
                        Path: '/',
                        AssumeRolePolicyDocument: '{}',
                    },
                ],
            });

            const sub = findSub('roles');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('AdminRole');
            expect(text).toContain('ReadOnlyRole');
            expect(text).toContain('AROACKCEVSQ6C2EXAMPLE');
            expect(text).toContain('2021-03-10');
        });

        it('should return warning when no roles found', async () => {
            iamMock.on(ListRolesCommand).resolves({ Roles: [] });

            const sub = findSub('roles');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No IAM roles found');
        });
    });

    // -------------------------------------------------------------------
    // policies
    // -------------------------------------------------------------------
    describe('policies', () => {
        it('should return table of IAM policies with AttachmentCount', async () => {
            iamMock.on(ListPoliciesCommand).resolves({
                Policies: [
                    {
                        PolicyName: 'MyCustomPolicy',
                        Arn: 'arn:aws:iam::123456789012:policy/MyCustomPolicy',
                        AttachmentCount: 3,
                        PolicyId: 'ANPACKCEVSQ6C2EXAMPLE',
                        Path: '/',
                        DefaultVersionId: 'v1',
                    },
                    {
                        PolicyName: 'AnotherPolicy',
                        Arn: 'arn:aws:iam::123456789012:policy/AnotherPolicy',
                        AttachmentCount: 0,
                        PolicyId: 'ANPACKCEVSQ6C3EXAMPLE',
                        Path: '/',
                        DefaultVersionId: 'v2',
                    },
                ],
            });

            const sub = findSub('policies');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('MyCustomPolicy');
            expect(text).toContain('AnotherPolicy');
            expect(text).toContain('arn:aws:iam::123456789012:policy/MyCustomPolicy');
            expect(text).toContain('3');
        });

        it('should return warning when no policies found', async () => {
            iamMock.on(ListPoliciesCommand).resolves({ Policies: [] });

            const sub = findSub('policies');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No IAM policies found');
        });
    });
});
