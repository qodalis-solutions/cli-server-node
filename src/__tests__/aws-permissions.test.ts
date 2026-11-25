/**
 * The aws plugin's permissions: aws:read on the root `aws` command (every sub-command), aws:write on the ones that
 * change something, both in the permission catalog (group AWS) once the module is added; enforced through
 * POST /execute on a protected server. Also ICliModule.permissions in general (addModule).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { AwsModule, AwsPermissions, AWS_PERMISSION_ENTRIES } from '@qodalis/cli-server-plugin-aws';
import type { ICliCommandProcessor } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { protect, runCommand } from './command-test-helpers';

const disposables: Array<() => void> = [];
afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

function start(): CliServerResult {
    const cli = createCliServer({ configure: (b) => b.addModule(new AwsModule()) });
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return cli;
}

/** Every command path under `aws` with its own requiredPermissions: `{ 's3 rm': ['aws:write'], ... }`. */
function permissionsByPath(root: ICliCommandProcessor): Record<string, string[] | undefined> {
    const out: Record<string, string[] | undefined> = {};
    const walk = (p: ICliCommandProcessor, path: string[]) => {
        for (const child of p.processors ?? []) {
            const childPath = [...path, child.command];
            out[childPath.join(' ')] = child.requiredPermissions;
            walk(child, childPath);
        }
    };
    walk(root, []);
    return out;
}

const WRITE = ['configure set', 's3 cp', 's3 rm', 's3 mb', 's3 rb', 'ec2 start', 'ec2 stop', 'ec2 reboot', 'lambda invoke', 'sqs send', 'sqs purge', 'sns publish'];

describe('aws permissions', () => {
    it('aws:read on the root, aws:write on exactly the changing sub-commands', () => {
        const cli = start();
        const root = cli.registry.findProcessor('aws')!;
        expect(root.requiredPermissions).toEqual([AwsPermissions.Read]);
        const byPath = permissionsByPath(root);
        for (const path of WRITE) expect(byPath[path], path).toEqual(['aws:write']);
        const others = Object.entries(byPath).filter(([path]) => !WRITE.includes(path));
        expect(others.length).toBeGreaterThan(20);
        for (const [path, permissions] of others) expect(permissions, path).toBeUndefined();
    });

    it('adds aws:read and aws:write to the catalog (group AWS, surface cli), once', () => {
        const cli = start();
        cli.builder.addModule(new AwsModule());
        const entries = cli.builder.permissions.all().filter((p: any) => p.group === 'AWS');
        expect(entries.map((p: any) => [p.name, p.surface])).toEqual([
            ['aws:read', 'cli'],
            ['aws:write', 'cli'],
        ]);
        expect(AWS_PERMISSION_ENTRIES.map((e) => e.name)).toEqual(['aws:read', 'aws:write']);
    });

    it('a host entry with the same name stays as the host registered it', () => {
        const cli = createCliServer();
        disposables.push(() => {
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        cli.builder.addPermissions([{ name: 'aws:read', description: 'Mine', group: 'Host' }]);
        cli.builder.addModule(new AwsModule());
        expect(cli.builder.permissions.find('aws:read')).toMatchObject({ description: 'Mine', group: 'Host', surface: 'host' });
        expect(cli.builder.permissions.find('aws:write')).toMatchObject({ group: 'AWS', surface: 'cli' });
    });

    it('on a protected server: aws:read to read, aws:write as well to change', async () => {
        const cli = start();
        const { plugin, tokens } = await protect(cli, {
            runner: ['commands:execute'],
            reader: ['commands:execute', 'aws:read'],
            writer: ['commands:execute', 'aws:read', 'aws:write'],
            writeOnly: ['commands:execute', 'aws:write'],
        });
        disposables.push(() => plugin.dispose());

        const noRead = await runCommand(cli, 'aws configure get', tokens.runner);
        expect(noRead.status).toBe(403);
        expect(noRead.body.error).toContain('aws:read');
        expect((await runCommand(cli, 'aws configure get', tokens.reader)).status).toBe(200);

        const noWrite = await runCommand(cli, 'aws configure set --region eu-north-1', tokens.reader);
        expect(noWrite.status).toBe(403);
        expect(noWrite.body.error).toContain('aws:write');
        expect((await runCommand(cli, 'aws s3 rm s3://bucket/key', tokens.reader)).status).toBe(403);
        expect((await runCommand(cli, 'aws ec2 stop i-123', tokens.reader)).status).toBe(403);

        // aws:write alone is not enough: the root needs aws:read
        expect((await runCommand(cli, 'aws configure set --region eu-north-1', tokens.writeOnly)).status).toBe(403);

        const ok = await runCommand(cli, 'aws configure set --region eu-north-1', tokens.writer);
        expect(ok.status).toBe(200);
        expect(ok.text).toContain('AWS configuration updated.');
        expect((await runCommand(cli, 'aws configure get', tokens.writer)).text).toContain('eu-north-1');
    });
});
