import {
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliProcessCommand,
    getPositionals,
    ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import { ADMIN_ACCESS_PERMISSION } from '../auth/auth-provider';
import { DEFAULT_HISTORY_MINUTES, MAX_HISTORY_MINUTES, StatusDeps, statusSnapshot } from '../controllers/status-controller';
import type { WsClientsDeps } from '../controllers/ws-clients-controller';
import { LOG_LEVELS, LogEntry, LogRingBuffer } from '../services/log-ring-buffer';
import { ModuleInfo, ModuleRegistry } from '../services/module-registry';
import type { CliInstalledPlugin } from '../services/package-info';
import { QueryError, parseSince } from '../services/query-time';
import { StatusSampler, summarizeStatusHistory } from '../services/status-sampler';

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
            ['Memory', mb(status.memoryUsageMb)],
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
    description = 'Command modules: list them, enable or disable one';
    processors: ICliCommandProcessor[];
    parameters = [jsonParam];
    private readonly list: AdminPluginsListProcessor;

    constructor(registry: ModuleRegistry) {
        super();
        this.list = new AdminPluginsListProcessor(registry);
        this.processors = [this.list, new AdminPluginsSwitchProcessor(registry, true), new AdminPluginsSwitchProcessor(registry, false)];
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

/**
 * `admin`: `status [--history]`, `plugins [list|enable|disable <id>]`, `clients`, `logs [...]`. Needs `admin:access`
 * on a protected server; `logs` also `logs:read`. Server settings are the core `config` command.
 */
export class CliAdminCommandProcessor extends CliCommandProcessor {
    command = 'admin';
    description = 'Server administration: status, command modules, WebSocket clients, logs';
    module = ADMIN_MODULE_NAME;
    icon = '🛠️';
    requiredPermissions = [ADMIN_ACCESS_PERMISSION];
    processors: ICliCommandProcessor[];
    private readonly status: AdminStatusProcessor;

    constructor(deps: AdminCommandDeps) {
        super();
        this.status = new AdminStatusProcessor(deps);
        this.processors = [this.status, new AdminPluginsProcessor(deps.moduleRegistry), new AdminClientsProcessor(deps.clients), new AdminLogsProcessor(deps.logBuffer)];
    }

    /** `admin` alone: the status. */
    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.status.handleAsync(command);
    }
}
