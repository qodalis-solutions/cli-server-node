/**
 * The core http command needs http:request (the command and its sub-commands): in the permission catalog (group
 * Commands) and enforced through POST /execute on a protected server.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliHttpCommandProcessor } from '../processors';
import { protect, runCommand } from './command-test-helpers';

const disposables: Array<() => void> = [];
afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

function start(): CliServerResult {
    const cli = createCliServer({ configure: (b) => b.addProcessor(new CliHttpCommandProcessor()) });
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return cli;
}

describe('http:request', () => {
    it('is in the core catalog and on the http command', () => {
        const cli = start();

        expect(cli.builder.permissions.find('http:request')).toMatchObject({
            description: 'Make HTTP requests from the server',
            group: 'Commands',
            surface: 'cli',
        });
        expect(new CliHttpCommandProcessor().requiredPermissions).toEqual(['http:request']);
    });

    it('on a protected server: refused without http:request, allowed with it', async () => {
        const cli = start();
        const { plugin, tokens } = await protect(cli, {
            runner: ['commands:execute'],
            requester: ['commands:execute', 'http:request'],
        });
        disposables.push(() => plugin.dispose());

        const refused = await runCommand(cli, 'http', tokens.runner);
        expect(refused.status).toBe(403);
        expect(refused.body.error).toContain('http:request');
        expect((await runCommand(cli, 'http get https://example.com', tokens.runner)).status).toBe(403);

        const allowed = await runCommand(cli, 'http', tokens.requester);
        expect(allowed.status).toBe(200);
        expect(allowed.text).toContain('Usage: http get|post');
    });
});
