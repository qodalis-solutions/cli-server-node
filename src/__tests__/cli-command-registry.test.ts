import { describe, it, expect, beforeEach } from 'vitest';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { CliProcessCommand } from '../abstractions/cli-process-command';

function makeProcessor(
    command: string,
    opts?: Partial<ICliCommandProcessor>,
): ICliCommandProcessor {
    return {
        command,
        description: `${command} processor`,
        author: DefaultLibraryAuthor,
        version: '1.0.0',
        handleAsync: async (_cmd: CliProcessCommand) => `${command} result`,
        ...opts,
    };
}

describe('CliCommandRegistry', () => {
    let registry: CliCommandRegistry;

    beforeEach(() => {
        registry = new CliCommandRegistry();
    });

    it('should register a processor and find it by command name', () => {
        const proc = makeProcessor('echo');
        registry.register(proc);

        const found = registry.findProcessor('echo');
        expect(found).toBe(proc);
    });

    it('should find processor case-insensitively', () => {
        const proc = makeProcessor('echo');
        registry.register(proc);

        expect(registry.findProcessor('ECHO')).toBe(proc);
        expect(registry.findProcessor('Echo')).toBe(proc);
        expect(registry.findProcessor('eCHo')).toBe(proc);
    });

    it('should return undefined for unknown command', () => {
        registry.register(makeProcessor('echo'));

        expect(registry.findProcessor('unknown')).toBeUndefined();
    });

    it('should resolve chain commands through nested processors', () => {
        const subProc = makeProcessor('encode');
        const parent = makeProcessor('base64', { processors: [subProc] });
        registry.register(parent);

        const found = registry.findProcessor('base64', ['encode']);
        expect(found).toBe(subProc);
    });

    it('should resolve deeply nested chain commands', () => {
        const leaf = makeProcessor('sha256');
        const mid = makeProcessor('compute', { processors: [leaf] });
        const parent = makeProcessor('hash', { processors: [mid] });
        registry.register(parent);

        const found = registry.findProcessor('hash', ['compute', 'sha256']);
        expect(found).toBe(leaf);
    });

    it('should return parent when allowUnlistedCommands is true and subcommand not found', () => {
        const parent = makeProcessor('curl', { allowUnlistedCommands: true });
        registry.register(parent);

        const found = registry.findProcessor('curl', ['https://example.com']);
        expect(found).toBe(parent);
    });

    it('should return undefined when subcommand not found and allowUnlistedCommands is false', () => {
        const parent = makeProcessor('git', { allowUnlistedCommands: false });
        registry.register(parent);

        const found = registry.findProcessor('git', ['push']);
        expect(found).toBeUndefined();
    });

    it('should list all registered processors', () => {
        registry.register(makeProcessor('echo'));
        registry.register(makeProcessor('status'));
        registry.register(makeProcessor('uuid'));

        expect(registry.processors).toHaveLength(3);
        expect(registry.processors.map((p) => p.command)).toEqual(['echo', 'status', 'uuid']);
    });

    it('should overwrite a processor if re-registered with same command', () => {
        const first = makeProcessor('echo');
        const second = makeProcessor('echo', { description: 'updated' });
        registry.register(first);
        registry.register(second);

        const found = registry.findProcessor('echo');
        expect(found).toBe(second);
        expect(found!.description).toBe('updated');
        expect(registry.processors).toHaveLength(1);
    });
});
