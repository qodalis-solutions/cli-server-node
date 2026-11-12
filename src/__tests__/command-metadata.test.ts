import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createCliServer } from '../create-cli-server';
import { CliCommandProcessor, CliCommandParameterDescriptor, CliProcessCommand, ICliCommandProcessor } from '../abstractions';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { processorPermissions } from '../auth/cli-server-auth-gate';
import { CliHashCommandProcessor } from '../processors/cli-hash-command-processor';
import { commandInputSchema } from '../mcp/providers/commands-provider';
import { validateMcpArguments } from '../mcp/mcp-schema';

class ShowProcessor extends CliCommandProcessor {
    command = 'show';
    description = 'Shows a thing';
    aliases = ['sh'];
    requiredPermissions = ['things:read'];
    async handleAsync(command: CliProcessCommand): Promise<string> {
        return `show ${command.value ?? ''}`.trim();
    }
}

class ThingsProcessor extends CliCommandProcessor {
    command = 'things';
    description = 'Manages things';
    aliases = ['th'];
    module = 'inventory';
    icon = '📦';
    documentation = 'First paragraph.\n\nSecond paragraph.';
    examples = [{ command: 'things show 1', description: 'Shows thing 1' }, { command: 'things' }];
    requiredPermissions = ['things:use'];
    parameters = [
        new CliCommandParameterDescriptor('format', 'Output format', false, 'string', ['f'], 'table', ['table', 'json'], ['json']),
        new CliCommandParameterDescriptor('verbose', 'More output', false, 'boolean'),
    ];
    processors: ICliCommandProcessor[] = [new ShowProcessor()];
    async handleAsync(): Promise<string> {
        return 'things';
    }
}

function app() {
    return createCliServer({ configure: (b) => b.addProcessor(new ThingsProcessor()) }).app;
}

describe('Command metadata', () => {
    it('GET /commands sends aliases, examples, documentation, module, icon, allowed values and parameter examples', async () => {
        const res = await request(app()).get('/api/v1/qcli/commands').expect(200);
        const things = res.body.find((c: any) => c.command === 'things');
        expect(things).toMatchObject({
            aliases: ['th'],
            module: 'inventory',
            icon: '📦',
            documentation: 'First paragraph.\n\nSecond paragraph.',
            examples: [{ command: 'things show 1', description: 'Shows thing 1' }, { command: 'things' }],
        });
        expect(things.parameters[0].allowedValues).toEqual(['table', 'json']);
        expect(things.parameters[0].examples).toEqual(['json']);
        expect(things.parameters[1]).not.toHaveProperty('allowedValues');
        expect(things.parameters[1]).not.toHaveProperty('examples');
        expect(things.processors[0]).toMatchObject({ command: 'show', aliases: ['sh'] });
        expect(things.processors[0]).not.toHaveProperty('examples');
        expect(things.processors[0]).not.toHaveProperty('module');
    });

    it('runs a command and a sub-command by alias', async () => {
        const a = app();
        const root = await request(a).post('/api/v1/qcli/execute').send({ command: 'TH', chainCommands: [], args: {} });
        expect(root.body).toMatchObject({ exitCode: 0, outputs: [{ type: 'text', value: 'things' }] });
        const sub = await request(a).post('/api/v1/qcli/execute').send({ command: 'th', chainCommands: ['sh'], value: '7', args: {} });
        expect(sub.body).toMatchObject({ exitCode: 0, outputs: [{ type: 'text', value: 'show 7' }] });
    });

    it('a command name wins over another command\'s alias', () => {
        const registry = new CliCommandRegistry();
        registry.register(new ThingsProcessor());
        const th = new ShowProcessor();
        th.command = 'th';
        registry.register(th);
        expect(registry.findProcessor('th')?.description).toBe('Shows a thing');
    });

    it('an alias carries the permissions of the command it names', () => {
        const registry = new CliCommandRegistry();
        registry.register(new ThingsProcessor());
        expect(processorPermissions(registry, 'th', ['sh'])).toEqual(['things:use', 'things:read']);
    });

    it('MCP schemas list allowed values as an enum and refuse other values', () => {
        const schema = commandInputSchema(new ThingsProcessor());
        expect(schema.properties.format.enum).toEqual(['table', 'json']);
        expect(schema.properties.format.examples).toEqual(['json']);
        expect(schema.properties.verbose).not.toHaveProperty('examples');
        expect(validateMcpArguments(schema, { format: 'xml' })).toBe("argument 'format' must be one of: table, json");
        expect(validateMcpArguments(schema, { format: 'json' })).toBeUndefined();
    });

    it('built-in commands carry examples and documentation', () => {
        const hash = new CliHashCommandProcessor();
        expect(hash.examples?.length).toBeGreaterThan(0);
        expect(hash.documentation).toBeTruthy();
        expect(hash.parameters[0].allowedValues).toEqual(['md5', 'sha1', 'sha256', 'sha512']);
    });
});
