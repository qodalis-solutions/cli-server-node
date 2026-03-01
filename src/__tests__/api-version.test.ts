import { describe, it, expect } from 'vitest';
import { CliCommandProcessor } from '../abstractions/cli-command-processor';
import { CliProcessCommand } from '../abstractions/cli-process-command';

class TestProcessor extends CliCommandProcessor {
    command = 'test';
    description = 'A test processor';

    async handleAsync(_cmd: CliProcessCommand): Promise<string> {
        return 'test result';
    }
}

class V2Processor extends CliCommandProcessor {
    command = 'v2-only';
    description = 'A v2 processor';
    override apiVersion = 2;

    async handleAsync(_cmd: CliProcessCommand): Promise<string> {
        return 'v2 result';
    }
}

describe('CliCommandProcessor apiVersion', () => {
    it('should default apiVersion to 1', () => {
        const proc = new TestProcessor();
        expect(proc.apiVersion).toBe(1);
    });

    it('should allow apiVersion to be overridden', () => {
        const proc = new V2Processor();
        expect(proc.apiVersion).toBe(2);
    });

    it('should default version to 1.0.0', () => {
        const proc = new TestProcessor();
        expect(proc.version).toBe('1.0.0');
    });

    it('should have default author set to DefaultLibraryAuthor', () => {
        const proc = new TestProcessor();
        expect(proc.author.name).toBe('Nicolae Lupei');
        expect(proc.author.email).toBe('nicolae.lupei@qodalis.com');
    });
});
