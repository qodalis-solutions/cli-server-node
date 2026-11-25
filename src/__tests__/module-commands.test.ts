/**
 * GET /commands lists a command added by a module under the module's name (`module`), unless the command names a
 * module itself: the aws module, the demo's own commands (demo module) and the built-in commands (core).
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { AwsModule } from '@qodalis/cli-server-plugin-aws';
import { ICliModule } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliBuilder } from '../extensions/cli-builder';
import { ICliCommandProcessor } from '../abstractions';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { CliBase64CommandProcessor, CliHashCommandProcessor, CliHttpCommandProcessor, CliSystemCommandProcessor } from '../processors';
import { DemoModule } from '../../demo/src/demo-module';

const disposables: Array<() => void> = [];
afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

function cmd(command: string, module?: string): ICliCommandProcessor {
    return {
        command,
        description: command,
        author: DefaultLibraryAuthor,
        version: '1.0.0',
        ...(module ? { module } : {}),
        handleAsync: async () => command,
    };
}

function start(configure: (b: CliBuilder) => void): CliServerResult {
    const cli = createCliServer({ configure });
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return cli;
}

async function modules(cli: CliServerResult): Promise<Record<string, string | undefined>> {
    const res = await request(cli.app).get('/api/v1/qcli/commands');
    expect(res.status).toBe(200);
    return Object.fromEntries((res.body as Array<{ command: string; module?: string }>).map((c) => [c.command, c.module]));
}

describe('module of the listed commands', () => {
    it("a module's commands carry its name; their own module wins; commands added on their own have none", async () => {
        const shop: ICliModule = {
            name: 'shop',
            version: '1.0.0',
            description: 'Shop',
            author: DefaultLibraryAuthor,
            processors: [cmd('orders'), cmd('stats', 'reports')],
        };
        const cli = start((b) => b.addModule(shop).addProcessor(cmd('loose')));

        const list = await modules(cli);

        expect(list.orders).toBe('shop');
        expect(list.stats).toBe('reports');
        expect(list.loose).toBeUndefined();
        // the processor itself is unchanged
        expect(shop.processors[0]).not.toHaveProperty('module');
    });

    it('the registry records the module a processor was registered with', () => {
        const registry = new CliCommandRegistry();
        const a = cmd('a');
        const b = cmd('b');
        registry.register(a, 'mod');
        registry.register(b);

        expect(registry.moduleOf(a)).toBe('mod');
        expect(registry.moduleOf(b)).toBeUndefined();

        // registered again on its own, it no longer belongs to the module
        registry.register(a);
        expect(registry.moduleOf(a)).toBeUndefined();
    });

    it('aws is listed under the aws module', async () => {
        const cli = start((b) => b.addModule(new AwsModule()));

        expect((await modules(cli)).aws).toBe('aws');
    });

    it("the demo's own commands are listed under the demo module", async () => {
        const cli = start((b) => b.addModule(new DemoModule()));

        const list = await modules(cli);

        for (const command of ['echo', 'status', 'time', 'hello', 'math']) expect(list[command]).toBe('demo');
        expect(cli.builder.modules.map((m) => m.name)).toContain('demo');
    });

    it('the built-in system, http, hash and base64 commands are listed under core', async () => {
        const cli = start((b) =>
            b
                .addProcessor(new CliSystemCommandProcessor())
                .addProcessor(new CliHttpCommandProcessor())
                .addProcessor(new CliHashCommandProcessor())
                .addProcessor(new CliBase64CommandProcessor()),
        );

        const list = await modules(cli);

        for (const command of ['system', 'http', 'hash', 'base64']) expect(list[command]).toBe('core');
    });
});
