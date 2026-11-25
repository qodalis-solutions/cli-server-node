import { CliCommandParameterDescriptor, CliCommandProcessor, CliProcessCommand, getCliCaller, getPositionals } from '@qodalis/cli-server-abstractions';
import { DashboardMarketplaceActor, DashboardMarketplaceError } from '../services/dashboard-marketplace';
import { formatTable } from './format-table';
import { PLUGINS_INSTALL_PERMISSION, SERVER_PLUGIN_PLATFORM, ServerPluginChangeResult, ServerPluginMarketplace } from '../services/server-plugin-marketplace';

const jsonParam = new CliCommandParameterDescriptor('json', 'Print the result as JSON', false, 'boolean');
const json = (value: unknown) => JSON.stringify(value, null, 2);

/** `2026-11-25T10:04:05.123Z` -> `2026-11-25 10:04:05`. */
const shortTime = (iso: string) => (iso ? iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '') : '-');

function actor(): DashboardMarketplaceActor {
    const caller = getCliCaller();
    return caller ? { userId: caller.userId, userName: caller.userName } : { userName: 'anonymous' };
}

async function call(fn: () => Promise<string>): Promise<string> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof DashboardMarketplaceError) return `Error: ${err.message}`;
        throw err;
    }
}

/** `jobs@1.2.0` -> name and version (a scoped package keeps its leading `@`). */
function spec(text: string): [string, string | undefined] {
    const at = text.lastIndexOf('@');
    return at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [text, undefined];
}

const restartLine = (r: ServerPluginChangeResult) =>
    r.restartRequired ? 'Restart the server to apply it: admin restart (or the dashboard).' : 'No restart needed: the server already runs this.';

class SearchProcessor extends CliCommandProcessor {
    command = 'search';
    description = "Searches the marketplace's server plugins: this server's package, version, platforms, whether it can be installed";
    acceptsValue = true;
    parameters = [jsonParam];
    examples = [{ command: 'admin plugins search jobs', description: 'Server plugins about jobs' }];

    constructor(private readonly marketplace: ServerPluginMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return call(async () => {
            const query = getPositionals(command).join(' ');
            const result = await this.marketplace.search({ query, pageSize: 50 });
            if (command.args?.json) return json(result);
            if (result.items.length === 0) return query ? `No server plugins match "${query}".` : 'The marketplace lists no server plugins.';
            const rows = result.items.map((p) => {
                let status: string;
                if (p.platform?.installed) status = p.updateAvailable ? `installed ${p.platform.installed}, update available` : `installed ${p.platform.installed}`;
                else status = p.allowed ? 'installable' : `blocked: ${p.blockedReason}${p.autoInstallReason ? ` (${p.autoInstallReason})` : ''}`;
                return [
                    p.name,
                    p.platform?.package ?? `(not for ${SERVER_PLUGIN_PLATFORM})`,
                    p.platform?.latest ?? '-',
                    [SERVER_PLUGIN_PLATFORM, ...p.otherPlatforms].filter((x) => x !== SERVER_PLUGIN_PLATFORM || p.platform).join(', '),
                    `${p.publisher?.name ?? '-'}${p.publisher?.verified ? ' (verified)' : ''}`,
                    status,
                ];
            });
            const more = result.total > result.items.length ? [`${result.items.length} of ${result.total} shown`] : [];
            return [formatTable(['Plugin', 'Package', 'Version', 'Platforms', 'Publisher', 'Status'], rows), ...more].join('\n');
        });
    }
}

class InstalledProcessor extends CliCommandProcessor {
    command = 'installed';
    description = 'Lists the server plugins installed from the marketplace: package, version, status (loaded, pending restart, failed)';
    parameters = [jsonParam];

    constructor(private readonly marketplace: ServerPluginMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return call(async () => {
            const plugins = await this.marketplace.installed({ checkUpdates: true });
            if (command.args?.json) return json(plugins);
            const { marketplaceUrl, install } = this.marketplace.info();
            if (plugins.length === 0) return `No server plugins installed from the marketplace (${marketplaceUrl}, install: ${install}; admin plugins search <query> finds some).`;
            const statusText = (p: (typeof plugins)[number]) =>
                p.status === 'pending' ? 'pending restart' : p.status === 'removed' ? 'removed, running until a restart' : p.error ? `${p.status}: ${p.error}` : p.status;
            return [
                `${plugins.length} server plugin(s) from ${marketplaceUrl} (install: ${install})`,
                formatTable(
                    ['Plugin', 'Package', 'Version', 'Status', 'Installed', 'By'],
                    plugins.map((p) => [p.name, p.package, `${p.version}${p.updateAvailable ? ' (update available)' : ''}`, statusText(p), shortTime(p.installedAt), p.installedBy || '-']),
                ),
            ].join('\n');
        });
    }
}

class InstallProcessor extends CliCommandProcessor {
    command = 'install';
    description = "Installs a server plugin from the marketplace (this server's package, the newest compatible version or name@version); runs after a restart";
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [PLUGINS_INSTALL_PERMISSION];
    examples = [
        { command: 'admin plugins install weather', description: 'The newest compatible version' },
        { command: 'admin plugins install jobs@1.0.0-beta.31', description: 'A given version' },
    ];

    constructor(private readonly marketplace: ServerPluginMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return call(async () => {
            const words = getPositionals(command);
            if (words.length !== 1) return 'Error: name one plugin: admin plugins install <name>[@version]';
            const [name, version] = spec(words[0]);
            const r = await this.marketplace.installPlugin(name, version, actor());
            return [`Installed ${r.name}: ${r.package}@${r.version}.`, restartLine(r)].join('\n');
        });
    }
}

class UpdateProcessor extends CliCommandProcessor {
    command = 'update';
    description = 'Updates an installed server plugin to the newest compatible version (or name@version); runs after a restart';
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [PLUGINS_INSTALL_PERMISSION];

    constructor(private readonly marketplace: ServerPluginMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return call(async () => {
            const words = getPositionals(command);
            if (words.length !== 1) return 'Error: name one plugin: admin plugins update <name>[@version]';
            const [name, version] = spec(words[0]);
            const r = await this.marketplace.updatePlugin(name, version, actor());
            if (r.changed === false) return `${r.name} is already at ${r.version}.`;
            return [`Updated ${r.name} from ${r.previousVersion} to ${r.version}.`, restartLine(r)].join('\n');
        });
    }
}

class RemoveProcessor extends CliCommandProcessor {
    command = 'remove';
    aliases = ['uninstall'];
    description = 'Removes a server plugin installed from the marketplace; it runs until a restart';
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [PLUGINS_INSTALL_PERMISSION];

    constructor(private readonly marketplace: ServerPluginMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return call(async () => {
            const words = getPositionals(command);
            if (words.length !== 1) return 'Error: name one plugin: admin plugins remove <name>';
            const r = await this.marketplace.removePlugin(words[0], actor());
            return [`Removed ${r.name} (${r.package}@${r.version}).`, restartLine(r)].join('\n');
        });
    }
}

/** `admin plugins search|installed|install|update|remove`: server plugins from the marketplace. */
export function serverPluginProcessors(marketplace: ServerPluginMarketplace): CliCommandProcessor[] {
    return [new SearchProcessor(marketplace), new InstalledProcessor(marketplace), new InstallProcessor(marketplace), new UpdateProcessor(marketplace), new RemoveProcessor(marketplace)];
}
