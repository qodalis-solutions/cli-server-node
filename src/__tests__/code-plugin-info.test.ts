/**
 * A plugin added in code (`builder.addPlugin`) is listed with its version and description: from the entry's
 * plugin info, else its package's package.json, else the module it returns; 0.0.0 only when nothing says one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { CliCommandProcessor, type CliPluginEntry, type ICliModule } from '@qodalis/cli-server-abstractions';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { codePluginPackageInfo } from '../server-plugins/cli-server-plugins';
import * as docsEntry from '../../plugins/docs/plugin';
import * as weatherEntry from '../../plugins/weather/plugin';

const ROOT = resolve(__dirname, '..', '..');
const dirs: string[] = [];
const servers: CliServerResult[] = [];
afterEach(() => {
    for (const s of servers.splice(0)) {
        s.eventSocketManager.dispose();
        s.logSocketManager.dispose();
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(entry: CliPluginEntry, options: Record<string, unknown> = {}): Promise<CliServerResult> {
    const dir = mkdtempSync(join(tmpdir(), 'qcli-code-plugin-'));
    dirs.push(dir);
    const cli = createCliServer({ dataDir: dir, configure: (b) => b.addPlugin(entry, options) });
    servers.push(cli);
    await cli.serverPlugins.ready();
    return cli;
}

const listed = (cli: CliServerResult, id: string) => cli.builder.installedPlugins.find((p) => p.id === id);
const pkgJson = (dir: string) => JSON.parse(readFileSync(join(ROOT, 'plugins', dir, 'package.json'), 'utf8')) as { version: string; description: string };

class Hello extends CliCommandProcessor {
    command = 'hello-code';
    description = 'Says hello';
    async handleAsync(): Promise<string> {
        return 'hello';
    }
}

function moduleOf(version: string, description: string): ICliModule {
    return { name: 'acme-tools', version, description, processors: [new Hello()] };
}

describe('code plugins: version and description', () => {
    it("from the package's package.json when the entry says neither (docs, resolvable from the server)", async () => {
        const docs = pkgJson('docs');
        expect(codePluginPackageInfo('@qodalis/cli-server-plugin-docs')).toEqual({ version: docs.version, description: docs.description });
        const cli = await start(docsEntry as CliPluginEntry);
        expect(listed(cli, '@qodalis/cli-server-plugin-docs')).toMatchObject({ version: docs.version, description: docs.description, source: 'code' });
        expect(cli.serverPlugins.states().find((s) => s.name === 'docs')?.version).toBe(docs.version);
    });

    it('from what the module it returns lists when the package cannot be resolved (weather: its package.json, read by the module)', async () => {
        const weather = pkgJson('weather');
        expect(codePluginPackageInfo('@qodalis/cli-server-plugin-weather')).toBeUndefined();
        const cli = await start(weatherEntry as CliPluginEntry);
        expect(listed(cli, '@qodalis/cli-server-plugin-weather')).toMatchObject({ version: weather.version, description: weather.description, source: 'code' });
        expect(cli.serverPlugins.states().find((s) => s.name === 'weather')?.version).toBe(weather.version);
    });

    it("the entry's plugin info wins over the package and the module", async () => {
        const entry: CliPluginEntry = {
            plugin: { id: 'docs-pinned', package: '@qodalis/cli-server-plugin-docs', version: '9.9.9', description: 'Pinned in the entry' },
            createPlugin: () => moduleOf('1.2.3', 'From the module'),
        };
        const cli = await start(entry);
        expect(listed(cli, '@qodalis/cli-server-plugin-docs')).toMatchObject({ version: '9.9.9', description: 'Pinned in the entry' });
    });

    it('the version from the entry, the description from the package.json', async () => {
        const docs = pkgJson('docs');
        const entry: CliPluginEntry = {
            plugin: { id: 'docs-versioned', package: '@qodalis/cli-server-plugin-docs', version: '2.0.0' },
            createPlugin: () => moduleOf('1.2.3', 'From the module'),
        };
        const cli = await start(entry);
        expect(listed(cli, '@qodalis/cli-server-plugin-docs')).toMatchObject({ version: '2.0.0', description: docs.description });
    });

    it('an unknown package: the module; nothing at all: 0.0.0 and no description', async () => {
        const fromModule = await start({ plugin: { id: 'acme', package: '@acme/not-installed' }, createPlugin: () => moduleOf('3.4.5', 'Acme tools') });
        expect(listed(fromModule, '@acme/not-installed')).toMatchObject({ version: '3.4.5', description: 'Acme tools' });

        const bare = await start({ plugin: { id: 'bare', package: '@acme/bare' }, createPlugin: () => undefined });
        const plugin = listed(bare, '@acme/bare')!;
        expect(plugin.version).toBe('0.0.0');
        expect(plugin.description).toBeUndefined();
    });
});
