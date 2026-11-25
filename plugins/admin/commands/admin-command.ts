import {
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliProcessCommand,
    getCliCaller,
    getPositionals,
    ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import {
    DASHBOARD_INSTALL_PERMISSION,
    DashboardMarketplace,
    DashboardMarketplaceActor,
    DashboardMarketplaceError,
} from '../services/dashboard-marketplace';
import { ADMIN_ACCESS_PERMISSION } from '../auth/auth-provider';
import { DEFAULT_HISTORY_MINUTES, MAX_HISTORY_MINUTES, StatusDeps, statusSnapshot } from '../controllers/status-controller';
import type { WsClientsDeps } from '../controllers/ws-clients-controller';
import { LOG_LEVELS, LogEntry, LogRingBuffer } from '../services/log-ring-buffer';
import { ModuleInfo, ModuleRegistry } from '../services/module-registry';
import type { CliInstalledPlugin } from '../services/package-info';
import { QueryError, parseSince } from '../services/query-time';
import { StatusSampler, summarizeStatusHistory } from '../services/status-sampler';
import { AdminRestartProcessor } from './admin-restart-command';
import { serverPluginProcessors } from './admin-server-plugins-command';
import type { ServerPluginMarketplace } from '../services/server-plugin-marketplace';
import type { ICliServerRestart } from '@qodalis/cli-server-abstractions';

/** The permission `admin logs` needs besides `admin:access` (as the log socket and event audience do). */
export const LOGS_READ_PERMISSION = 'logs:read';

/** The module of the `admin` command (`admin plugins disable` refuses it: that would disable this command). */
export const ADMIN_MODULE_NAME = 'admin';

/** What the `admin` command reads: the same services the admin routes use. */
export interface AdminCommandDeps {
    statusDeps: StatusDeps;
    sampler: StatusSampler;
    moduleRegistry: ModuleRegistry;
    logBuffer: LogRingBuffer;
    clients: WsClientsDeps;
    installedPlugins: () => ReadonlyArray<CliInstalledPlugin>;
    /** Dashboard plugins from the marketplace (`admin dashboard`); absent when the marketplace is off. */
    marketplace?: DashboardMarketplace;
    /** Server plugins from the marketplace (`admin plugins search|installed|install|update|remove`). */
    serverMarketplace?: ServerPluginMarketplace;
    /** The server's restart service (`admin restart`); absent on a server without one. */
    restart?: ICliServerRestart;
}

const jsonParam = new CliCommandParameterDescriptor('json', 'Print the result as JSON', false, 'boolean');
const json = (value: unknown) => JSON.stringify(value, null, 2);

/** `2026-11-25T10:04:05.123Z` -> `2026-11-25 10:04:05`. */
export function shortTime(iso: string): string {
    return iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '');
}

/** 7384 -> `2 h 3 min`; under a minute `42 s`; from a day `3 d 4 h`. */
export function formatDuration(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return `${s} s`;
    const d = Math.floor(s / 86_400);
    const h = Math.floor((s % 86_400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d} d ${h} h`;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Aligned columns: every column but the last padded to its widest cell. */
export function formatTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
    const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
    return [line(headers), ...rows.map(line)].join('\n');
}

/** A whole number flag from 1 to `max`: `fallback` when absent, an error text when invalid. */
function intArg(command: CliProcessCommand, names: string[], fallback: number, max: number, label: string): number | string {
    const raw = names.map((n) => command.args?.[n]).find((v) => v !== undefined && v !== null);
    if (raw === undefined) return fallback;
    const n = raw === true ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) return `Error: ${label} must be a whole number from 1 to ${max}`;
    return n;
}

const pct = (n: number) => `${n}%`;
const mb = (n: number) => `${n} MB`;

/** 512 -> `512 MB`; from 1024 MB in GB with one decimal: 16384 -> `16 GB`, 10035 -> `9.8 GB`. */
export function formatMemorySize(megabytes: number): string {
    if (megabytes < 1024) return `${Math.round(megabytes)} MB`;
    return `${Math.round((megabytes / 1024) * 10) / 10} GB`;
}

/**
 * The Memory line of `admin status`: the process, then the machine's (or the container's) use of the RAM the server
 * can use: `146 MB (process) · machine 9.8 GB of 16 GB used (61%)`, `... · container 300 MB of 512 MB used (59%)`.
 * Only the process memory when the total is unknown; the total alone when the use is.
 */
export function formatMemoryLine(status: { memoryUsageMb: number; systemMemoryTotalMb: number | null; systemMemoryUsedMb: number | null; memoryLimited: boolean | null }): string {
    const total = status.systemMemoryTotalMb;
    if (total === null || total <= 0) return mb(status.memoryUsageMb);
    const scope = status.memoryLimited ? 'container' : 'machine';
    const used = status.systemMemoryUsedMb;
    const system =
        used === null
            ? `${scope}${status.memoryLimited ? ' limit' : ''} ${formatMemorySize(total)}`
            : `${scope} ${formatMemorySize(used)} of ${formatMemorySize(total)} used (${Math.round((used / total) * 100)}%)`;
    return `${mb(status.memoryUsageMb)} (process) · ${system}`;
}

class AdminStatusProcessor extends CliCommandProcessor {
    command = 'status';
    description = 'Shows the server status: version, uptime, platform, memory, CPU, connections; --history summarizes the recent samples';
    parameters = [
        new CliCommandParameterDescriptor('history', 'Summarize the samples of the last minutes instead (count, min/avg/max memory and CPU)', false, 'boolean'),
        new CliCommandParameterDescriptor('minutes', `With --history: how many minutes back (1-${MAX_HISTORY_MINUTES}, default ${DEFAULT_HISTORY_MINUTES})`, false, 'number'),
        jsonParam,
    ];
    examples = [
        { command: 'admin status', description: 'The status now' },
        { command: 'admin status --history --minutes 15', description: 'Memory and CPU over the last 15 minutes' },
    ];

    constructor(private readonly deps: AdminCommandDeps) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        if (command.args?.history) return this.history(command);
        if (command.args?.minutes !== undefined) return 'Error: --minutes goes with --history';
        const status = statusSnapshot(this.deps.statusDeps, this.deps.sampler);
        const server = this.deps.installedPlugins()[0];
        if (command.args?.json) return json({ server: server ? { id: server.id, version: server.version ?? null } : null, ...status });
        const rows: Array<[string, string]> = [
            ['Server', server ? `${server.id}${server.version ? ` ${server.version}` : ''}` : 'unknown'],
            ['Platform', `${status.platform} ${status.platformVersion} (${status.os})`],
            ['Uptime', `${formatDuration(status.uptimeSeconds)} (since ${shortTime(status.startedAt)})`],
            ['Memory', formatMemoryLine(status)],
            ['CPU', status.cpuUsagePercent === null ? 'n/a' : pct(status.cpuUsagePercent)],
            ['Connections', `${status.activeWsConnections} WebSocket, ${status.activeShellSessions} shell`],
            ['Commands', String(status.registeredCommands)],
            ['Jobs', String(status.registeredJobs)],
            ['Features', status.enabledFeatures.length ? status.enabledFeatures.join(', ') : 'none'],
        ];
        return rows.map(([k, v]) => `${k.padEnd(12)}${v}`).join('\n');
    }

    private history(command: CliProcessCommand): string {
        const minutes = intArg(command, ['minutes'], DEFAULT_HISTORY_MINUTES, MAX_HISTORY_MINUTES, '--minutes');
        if (typeof minutes === 'string') return minutes;
        const samples = this.deps.sampler.history(minutes);
        const summary = summarizeStatusHistory(samples);
        if (command.args?.json) return json({ minutes, intervalSeconds: this.deps.sampler.intervalSeconds, ...summary });
        if (summary.count === 0) return `No status samples in the last ${minutes} min.`;
        const r = (x: { min: number; avg: number; max: number }, unit: (n: number) => string) => `min ${unit(x.min)}  avg ${unit(x.avg)}  max ${unit(x.max)}`;
        return [
            `Last ${minutes} min: ${summary.count} sample(s) every ${this.deps.sampler.intervalSeconds} s, ${shortTime(summary.from!)} to ${shortTime(summary.to!)}`,
            `${'Memory'.padEnd(12)}${r(summary.memoryMb!, mb)}`,
            `${'CPU'.padEnd(12)}${summary.cpuPercent ? r(summary.cpuPercent, pct) : 'n/a'}`,
            `${'Peak'.padEnd(12)}${summary.maxWsConnections} WebSocket, ${summary.maxShellSessions} shell`,
        ].join('\n');
    }
}

function pluginRows(modules: ModuleInfo[]): string[][] {
    return modules.map((m) => [m.id, m.name, m.version || '-', m.enabled ? 'enabled' : 'disabled', String(m.processorCount)]);
}

class AdminPluginsListProcessor extends CliCommandProcessor {
    command = 'list';
    aliases = ['ls'];
    description = 'Lists the command modules: id, name, version, enabled or disabled, commands';
    parameters = [jsonParam];

    constructor(private readonly registry: ModuleRegistry) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const modules = this.registry.list();
        if (command.args?.json) return json(modules);
        if (modules.length === 0) return 'No command modules registered.';
        return formatTable(['ID', 'Name', 'Version', 'Status', 'Commands'], pluginRows(modules));
    }
}

class AdminPluginsSwitchProcessor extends CliCommandProcessor {
    command: string;
    description: string;
    acceptsValue = true;
    valueRequired = true;

    constructor(
        private readonly registry: ModuleRegistry,
        private readonly enable: boolean,
    ) {
        super();
        this.command = enable ? 'enable' : 'disable';
        this.description = enable
            ? 'Enables a command module (its commands run again)'
            : 'Disables a command module: its commands are refused until it is enabled';
        this.examples = [{ command: `admin plugins ${this.command} weather`, description: `${enable ? 'Enable' : 'Disable'} the weather module` }];
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const words = getPositionals(command);
        if (words.length !== 1) return `Error: name one module: admin plugins ${this.command} <id> (admin plugins lists them)`;
        const id = words[0];
        const target = this.registry.getById(id);
        if (!target) return `Error: unknown module: ${id} (admin plugins lists them)`;
        if (!this.enable && target.id === ADMIN_MODULE_NAME) return 'Error: the admin module cannot be disabled from the terminal: it would disable this command';
        const result = this.registry.setEnabled(id, this.enable)!;
        const state = this.enable ? 'enabled' : 'disabled';
        if (!result.changed) return `${result.module.id} is already ${state}.`;
        const n = result.module.processorCount;
        return `${this.enable ? 'Enabled' : 'Disabled'} ${result.module.id} (${n} command${n === 1 ? '' : 's'}).`;
    }
}

class AdminPluginsProcessor extends CliCommandProcessor {
    command = 'plugins';
    aliases = ['modules'];
    description = 'Command modules: list them, enable or disable one; server plugins from the marketplace: search, installed, install, update, remove';
    processors: ICliCommandProcessor[];
    parameters = [jsonParam];
    private readonly list: AdminPluginsListProcessor;

    constructor(registry: ModuleRegistry, serverMarketplace?: ServerPluginMarketplace) {
        super();
        this.list = new AdminPluginsListProcessor(registry);
        this.processors = [this.list, new AdminPluginsSwitchProcessor(registry, true), new AdminPluginsSwitchProcessor(registry, false)];
        if (serverMarketplace) this.processors.push(...serverPluginProcessors(serverMarketplace));
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.list.handleAsync(command);
    }
}

class AdminClientsProcessor extends CliCommandProcessor {
    command = 'clients';
    description = 'Lists the connected WebSocket clients: id, type, connected since, address';
    parameters = [jsonParam];

    constructor(private readonly clients: WsClientsDeps) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const clients = this.clients.getClients();
        if (command.args?.json) return json(clients);
        if (clients.length === 0) return 'No WebSocket clients connected.';
        return [
            `${clients.length} client(s)`,
            formatTable(
                ['ID', 'Type', 'Connected', 'Address'],
                clients.map((c) => [c.id, c.type, shortTime(c.connectedAt), c.remoteAddress || '-']),
            ),
        ].join('\n');
    }
}

/** One entry as a line of `admin logs`: time, level, [source], message. */
export function formatLogLine(entry: LogEntry): string {
    return `${shortTime(entry.timestamp)} ${entry.level.padEnd(5)} ${entry.source ? `[${entry.source}] ` : ''}${entry.message}`;
}

const MAX_LOG_LINES = 1000;
const LEVEL_NAMES = new Set<string>(LOG_LEVELS);

class AdminLogsProcessor extends CliCommandProcessor {
    command = 'logs';
    description = 'Shows the latest server log entries (oldest first), filtered by level, text, source and time';
    requiredPermissions = [LOGS_READ_PERMISSION];
    parameters = [
        new CliCommandParameterDescriptor('level', 'Only these levels, comma-separated: debug, info, warn, error', false, 'string'),
        new CliCommandParameterDescriptor('search', 'Only entries with this text in the message or the source (case-insensitive)', false, 'string'),
        new CliCommandParameterDescriptor('service', 'Only entries of this source', false, 'string'),
        new CliCommandParameterDescriptor('since', 'Only entries since a duration ago (30s, 5m, 1h, 7d) or an ISO 8601 date', false, 'string'),
        new CliCommandParameterDescriptor('limit', `How many entries (1-${MAX_LOG_LINES}, default 50)`, false, 'number', ['n'], 50),
        jsonParam,
    ];
    examples = [
        { command: 'admin logs', description: 'The last 50 entries' },
        { command: 'admin logs --level warn,error --since 1h', description: 'Warnings and errors of the last hour' },
        { command: 'admin logs --search timeout -n 200', description: 'The last 200 entries mentioning timeout' },
    ];

    constructor(private readonly logBuffer: LogRingBuffer) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const limit = intArg(command, ['limit', 'n'], 50, MAX_LOG_LINES, '--limit');
        if (typeof limit === 'string') return limit;
        const text = (name: string): string | undefined | Error => {
            const v = command.args?.[name];
            if (v === undefined || v === null) return undefined;
            if (v === true || String(v).trim() === '') return new Error(`Error: --${name} needs a value`);
            return String(v).trim();
        };
        const level = text('level');
        const search = text('search');
        const service = text('service');
        const sinceText = text('since');
        for (const v of [level, search, service, sinceText]) if (v instanceof Error) return v.message;
        if (typeof level === 'string') {
            const bad = level.split(',').map((l) => l.trim().toUpperCase()).filter((l) => l && !LEVEL_NAMES.has(l === 'WARNING' ? 'WARN' : l));
            if (bad.length) return `Error: unknown level ${bad.map((b) => b.toLowerCase()).join(', ')} (debug, info, warn, error)`;
        }
        let since: Date | undefined;
        if (typeof sinceText === 'string') {
            try {
                since = parseSince(sinceText, '--since');
            } catch (err) {
                if (err instanceof QueryError) return `Error: ${err.message}`;
                throw err;
            }
        }
        const levels = typeof level === 'string' ? level.replace(/\bwarning\b/gi, 'warn') : undefined;
        const filters = { level: levels, search: search as string | undefined, service: service as string | undefined, from: since };
        // The newest `limit` entries, oldest first (like tail)
        const { total } = this.logBuffer.query({ ...filters, limit: 0 });
        const result = this.logBuffer.query({ ...filters, limit, offset: Math.max(0, total - limit) });
        if (command.args?.json) return json({ entries: result.entries, total });
        if (result.entries.length === 0) return 'No log entries match.';
        const header = total > result.entries.length ? [`Last ${result.entries.length} of ${total} entries`] : [];
        return [...header, ...result.entries.map(formatLogLine)].join('\n');
    }
}

/** Who runs the command: the signed-in caller, else `anonymous` (a server without sign-in). */
function terminalActor(): DashboardMarketplaceActor {
    const caller = getCliCaller();
    return caller ? { userId: caller.userId, userName: caller.userName } : { userName: 'anonymous' };
}

/** Runs a marketplace call, turning its refusals into `Error: <reason>` (and a line per setting refused). */
async function marketplaceCall(fn: () => Promise<string>): Promise<string> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof DashboardMarketplaceError) {
            return [`Error: ${err.message}`, ...Object.entries(err.errors ?? {}).map(([key, message]) => `  ${key}: ${message}`)].join('\n');
        }
        throw err;
    }
}

const configParam = new CliCommandParameterDescriptor('config', "The values of the plugin's settings, a JSON object: --config '{\"refreshSeconds\":60}'", false, 'string');

/** `--config`: a JSON object (text, or already parsed by the client); undefined when absent. Throws 400 when it is not one. */
function configArg(command: CliProcessCommand): unknown {
    const raw = command.args?.config;
    if (raw === undefined || raw === null) return undefined;
    let value: unknown = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            value = undefined;
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DashboardMarketplaceError(400, 'invalid --config: use a JSON object, e.g. --config \'{"key":"value"}\'');
    }
    return value;
}

/** A setting's value as printed: strings as they are, anything else as JSON. */
function settingText(value: unknown): string {
    if (value === null || value === undefined) return '(none)';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/** `see the settings: admin dashboard info <name>` and the warnings, after an install or update. */
function afterChange(name: string, hasConfig: boolean, warnings: string[] | undefined): string[] {
    return [
        ...(warnings ?? []).map((w) => `Warning: ${w}`),
        ...(hasConfig ? [`Its settings: admin dashboard info ${name}`] : []),
    ];
}

class AdminDashboardListProcessor extends CliCommandProcessor {
    command = 'list';
    aliases = ['ls'];
    description = 'Lists the dashboard plugins installed from the marketplace: page id, package, version, who installed them';
    parameters = [jsonParam];

    constructor(private readonly marketplace: DashboardMarketplace) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const plugins = await this.marketplace.installed({ checkUpdates: true });
        if (command.args?.json) return json(plugins);
        const { marketplaceUrl, install } = this.marketplace.info();
        if (plugins.length === 0) return `No dashboard plugins installed (marketplace ${marketplaceUrl}, install: ${install}; admin dashboard search <query> finds some).`;
        return [
            `${plugins.length} dashboard plugin(s) from ${marketplaceUrl} (install: ${install})`,
            formatTable(
                ['ID', 'Package', 'Version', 'Installed', 'By'],
                plugins.map((p) => [p.id, p.name, `${p.version}${p.updateAvailable ? ' (update available)' : ''}`, shortTime(p.installedAt), p.installedBy || '-']),
            ),
        ].join('\n');
    }
}

class AdminDashboardSearchProcessor extends CliCommandProcessor {
    command = 'search';
    description = "Searches the marketplace's dashboard plugins: package, version, publisher, whether it can be installed";
    acceptsValue = true;
    parameters = [jsonParam];
    examples = [{ command: 'admin dashboard search tickets', description: 'Dashboard plugins about tickets' }];

    constructor(private readonly marketplace: DashboardMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return marketplaceCall(async () => {
            const query = getPositionals(command).join(' ');
            const result = await this.marketplace.search({ query, pageSize: 50 });
            if (command.args?.json) return json(result);
            if (result.items.length === 0) return query ? `No dashboard plugins match "${query}".` : 'The marketplace lists no dashboard plugins.';
            const status = (p: (typeof result.items)[number]): string => {
                if (p.installed) return p.updateAvailable ? `installed ${p.installed.version}, update available` : `installed ${p.installed.version}`;
                return p.allowed ? 'installable' : `blocked: ${p.blockedReason}`;
            };
            const rows = result.items.map((p) => [
                p.name,
                String(p.version ?? p.latest ?? '-'),
                `${p.publisher?.name ?? '-'}${p.publisher?.verified ? ' (verified)' : ''}`,
                `${status(p)}${p.requires && !p.requires.installed ? `; needs server plugin ${p.requires.serverPackage}` : ''}`,
            ]);
            const more = result.total > result.items.length ? [`${result.items.length} of ${result.total} shown`] : [];
            return [formatTable(['Package', 'Version', 'Publisher', 'Status'], rows), ...more].join('\n');
        });
    }
}

class AdminDashboardInstallProcessor extends CliCommandProcessor {
    command = 'install';
    description = 'Installs a dashboard plugin from the marketplace (the newest version this dashboard runs, or name@version)';
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [DASHBOARD_INSTALL_PERMISSION];
    examples = [
        { command: 'admin dashboard install @qodalis/cli-dashboard-module-jobs', description: 'The newest version' },
        { command: 'admin dashboard install @acme/cli-dashboard-tickets@1.2.0', description: 'A given version' },
        { command: `admin dashboard install @acme/cli-dashboard-tickets --config '{"refreshSeconds":60}'`, description: 'With values for its settings' },
    ];
    parameters = [configParam];

    constructor(private readonly marketplace: DashboardMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return marketplaceCall(async () => {
            const words = getPositionals(command);
            if (words.length !== 1) return 'Error: name one package: admin dashboard install <name>[@version]';
            const spec = words[0];
            const at = spec.lastIndexOf('@');
            const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
            const plugin = await this.marketplace.installPlugin(name, version, terminalActor(), configArg(command));
            return [`Installed ${plugin.name}@${plugin.version}: the dashboard page "${plugin.title}" (/x/${plugin.id}).`, ...afterChange(plugin.name, plugin.hasConfig, plugin.warnings)].join('\n');
        });
    }
}

class AdminDashboardUpdateProcessor extends CliCommandProcessor {
    command = 'update';
    description = "Updates an installed dashboard plugin to the newest version this dashboard runs (settings the new version still accepts are kept)";
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [DASHBOARD_INSTALL_PERMISSION];
    parameters = [configParam];

    constructor(private readonly marketplace: DashboardMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return marketplaceCall(async () => {
            const words = getPositionals(command);
            if (words.length !== 1) return 'Error: name one package: admin dashboard update <name>';
            const config = configArg(command);
            const result = await this.marketplace.updatePlugin(words[0], undefined, terminalActor(), config);
            if (!result.changed) {
                const applied = config && Object.keys(config).length > 0 ? ' Its settings were changed.' : '';
                return `${result.plugin.name} is already at ${result.plugin.version}, the newest version.${applied}`;
            }
            const dropped = result.configDropped.length ? [`Settings dropped (the new version no longer accepts them): ${result.configDropped.join(', ')}`] : [];
            return [`Updated ${result.plugin.name} from ${result.previousVersion} to ${result.plugin.version}.`, ...dropped, ...afterChange(result.plugin.name, result.plugin.hasConfig, result.warnings)].join('\n');
        });
    }
}

class AdminDashboardRemoveProcessor extends CliCommandProcessor {
    command = 'remove';
    aliases = ['uninstall'];
    description = 'Removes an installed dashboard plugin: its page and its files';
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [DASHBOARD_INSTALL_PERMISSION];

    constructor(private readonly marketplace: DashboardMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return marketplaceCall(async () => {
            const words = getPositionals(command);
            if (words.length !== 1) return 'Error: name one package: admin dashboard remove <name>';
            const plugin = await this.marketplace.removePlugin(words[0], terminalActor());
            return `Removed ${plugin.name}@${plugin.version} (the page ${plugin.id}).`;
        });
    }
}

class AdminDashboardInfoProcessor extends CliCommandProcessor {
    command = 'info';
    description = 'Shows an installed dashboard plugin: version, page, files, and its settings with their values';
    acceptsValue = true;
    valueRequired = true;
    parameters = [jsonParam];
    examples = [{ command: 'admin dashboard info @acme/cli-dashboard-tickets', description: 'The plugin and its settings' }];

    constructor(private readonly marketplace: DashboardMarketplace) {
        super();
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return marketplaceCall(async () => {
            const words = getPositionals(command);
            if (words.length !== 1) return 'Error: name one package: admin dashboard info <name>';
            const info = await this.marketplace.pluginInfo(words[0]);
            if (command.args?.json) return json(info);
            const p = info.plugin;
            const lines = [
                `${p.name}@${p.version}`,
                `  Page        ${p.title} (/x/${p.id})`,
                `  Installed   ${shortTime(p.installedAt)}${p.installedBy ? ` by ${p.installedBy}` : ''}`,
                `  Files       ${info.files.map((f) => `${f.file} (${f.size} bytes)`).join(', ')}`,
            ];
            if (info.settings.length === 0) return [...lines, '  Settings    none'].join('\n');
            lines.push(`Settings (config set dashboard-plugins.${p.id}.<key> <value>; version ${info.configVersion}):`);
            const rule = (s: (typeof info.settings)[number]): string => {
                const v = s.validation ?? {};
                return [
                    v.required ? 'required' : '',
                    v.min !== undefined ? `min ${v.min}` : '',
                    v.max !== undefined ? `max ${v.max}` : '',
                    v.pattern !== undefined ? `pattern ${v.pattern}` : '',
                    v.options?.length ? `one of ${v.options.join(', ')}` : '',
                ]
                    .filter(Boolean)
                    .join('; ');
            };
            lines.push(
                formatTable(
                    ['Key', 'Value', 'Type', 'Default', 'Rule'],
                    info.settings.map((s) => [s.key, `${settingText(s.value)}${s.isDefault ? '' : ' *'}`, s.type, settingText(s.default), rule(s) || '-']),
                ),
            );
            if (info.settings.some((s) => !s.isDefault)) lines.push('* changed from the default');
            return lines.join('\n');
        });
    }
}

class AdminDashboardProcessor extends CliCommandProcessor {
    command = 'dashboard';
    description = 'Dashboard plugins from the marketplace: list the installed ones, search, info, install, update, remove';
    processors: ICliCommandProcessor[];
    parameters = [jsonParam];
    private readonly list: AdminDashboardListProcessor;

    constructor(marketplace: DashboardMarketplace) {
        super();
        this.list = new AdminDashboardListProcessor(marketplace);
        this.processors = [
            this.list,
            new AdminDashboardSearchProcessor(marketplace),
            new AdminDashboardInfoProcessor(marketplace),
            new AdminDashboardInstallProcessor(marketplace),
            new AdminDashboardUpdateProcessor(marketplace),
            new AdminDashboardRemoveProcessor(marketplace),
        ];
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.list.handleAsync(command);
    }
}

/**
 * `admin`: `status [--history]`, `plugins [list|enable|disable <id>]`, `clients`, `logs [...]`, `restart [status]`,
 * `dashboard [list|search|info|install|update|remove]`. Needs `admin:access` on a protected server; `logs` also `logs:read`,
 * `dashboard install|update|remove` also `dashboard:install`. Server settings are the core `config` command.
 */
export class CliAdminCommandProcessor extends CliCommandProcessor {
    command = 'admin';
    description = 'Server administration: status, command modules, WebSocket clients, logs, dashboard plugins';
    module = ADMIN_MODULE_NAME;
    icon = '🛠️';
    requiredPermissions = [ADMIN_ACCESS_PERMISSION];
    processors: ICliCommandProcessor[];
    private readonly status: AdminStatusProcessor;

    constructor(deps: AdminCommandDeps) {
        super();
        this.status = new AdminStatusProcessor(deps);
        this.processors = [this.status, new AdminPluginsProcessor(deps.moduleRegistry, deps.serverMarketplace), new AdminClientsProcessor(deps.clients), new AdminLogsProcessor(deps.logBuffer)];
        if (deps.marketplace) this.processors.push(new AdminDashboardProcessor(deps.marketplace));
        if (deps.restart) this.processors.push(new AdminRestartProcessor(deps.restart));
    }

    /** `admin` alone: the status. */
    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.status.handleAsync(command);
    }
}
