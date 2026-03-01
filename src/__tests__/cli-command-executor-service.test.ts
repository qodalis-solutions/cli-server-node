import { describe, it, expect, beforeEach } from 'vitest';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { CliCommandExecutorService } from '../services/cli-command-executor-service';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { CliProcessCommand } from '../abstractions/cli-process-command';

function makeProcessor(
    command: string,
    handler: (cmd: CliProcessCommand) => Promise<string>,
): ICliCommandProcessor {
    return {
        command,
        description: `${command} processor`,
        author: DefaultLibraryAuthor,
        version: '1.0.0',
        handleAsync: handler,
    };
}

function makeCommand(command: string, overrides?: Partial<CliProcessCommand>): CliProcessCommand {
    return {
        command,
        chainCommands: [],
        rawCommand: command,
        args: {},
        ...overrides,
    };
}

describe('CliCommandExecutorService', () => {
    let registry: CliCommandRegistry;
    let executor: CliCommandExecutorService;

    beforeEach(() => {
        registry = new CliCommandRegistry();
        executor = new CliCommandExecutorService(registry);
    });

    it('should execute a known command and return exitCode 0', async () => {
        registry.register(
            makeProcessor('echo', async (cmd) => cmd.value ?? 'hello'),
        );

        const result = await executor.executeAsync(makeCommand('echo', { value: 'world' }));

        expect(result.exitCode).toBe(0);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0]).toEqual({ type: 'text', value: 'world' });
    });

    it('should return exitCode 1 for unknown command', async () => {
        const result = await executor.executeAsync(makeCommand('nope'));

        expect(result.exitCode).toBe(1);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0]).toEqual({
            type: 'text',
            value: 'Unknown command: nope',
            style: 'error',
        });
    });

    it('should return exitCode 1 when command handler throws', async () => {
        registry.register(
            makeProcessor('fail', async () => {
                throw new Error('something broke');
            }),
        );

        const result = await executor.executeAsync(makeCommand('fail'));

        expect(result.exitCode).toBe(1);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0]).toEqual({
            type: 'text',
            value: 'Error executing command: something broke',
            style: 'error',
        });
    });

    it('should handle thrown non-Error values gracefully', async () => {
        registry.register(
            makeProcessor('fail-string', async () => {
                throw 'raw string error';
            }),
        );

        const result = await executor.executeAsync(makeCommand('fail-string'));

        expect(result.exitCode).toBe(1);
        expect(result.outputs[0]).toEqual({
            type: 'text',
            value: 'Error executing command: raw string error',
            style: 'error',
        });
    });

    it('should resolve chain commands before executing', async () => {
        const subProc = makeProcessor('encode', async () => 'encoded');
        const parent: ICliCommandProcessor = {
            command: 'base64',
            description: 'base64 processor',
            author: DefaultLibraryAuthor,
            version: '1.0.0',
            processors: [subProc],
            handleAsync: async () => 'parent result',
        };
        registry.register(parent);

        const result = await executor.executeAsync(
            makeCommand('base64', { chainCommands: ['encode'] }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.outputs[0]).toEqual({ type: 'text', value: 'encoded' });
    });
});
