import {
    CLI_SERVER_RESTART_PERMISSION,
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliProcessCommand,
    CliServerRestartStatus,
    getCliCaller,
    hasCliPermission,
    ICliCommandProcessor,
    ICliServerRestart,
} from '@qodalis/cli-server-abstractions';

const jsonParam = new CliCommandParameterDescriptor('json', 'Print the result as JSON', false, 'boolean');

/** `2026-11-25T10:04:05.123Z` -> `2026-11-25 10:04:05`. */
const shortTime = (iso: string) => iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '');

/** The pending changes as lines: `  - CORS: Mode changed (config, since 2026-11-25 10:04:05)`. */
function pendingLines(status: CliServerRestartStatus): string[] {
    if (status.pending.length === 0) return ['No changes are waiting for a restart.'];
    return [
        `${status.pending.length} change(s) take effect after a restart:`,
        ...status.pending.map((p) => `  - ${p.description} (${p.source}, since ${shortTime(p.since)})`),
    ];
}

/** How the server restarts, in one line. */
function modeLine(status: CliServerRestartStatus): string {
    if (!status.supported) return `Restart from here: not supported (${status.reason ?? 'no mode'})`;
    const how =
        status.mode === 'exit'
            ? `exits for ${status.supervisor ?? 'the supervisor'} to start it again`
            : status.mode === 'self'
              ? 'starts itself again'
              : "the host's handler";
    return `Restart mode: ${status.mode} (${how})`;
}

class AdminRestartStatusProcessor extends CliCommandProcessor {
    command = 'status';
    description = 'Whether the server can restart itself, how, since when it runs, and the changes waiting for a restart';
    parameters = [jsonParam];

    constructor(private readonly restart: ICliServerRestart) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const status = this.restart.status();
        if (command.args?.json) return JSON.stringify(status, null, 2);
        return [`Running since ${shortTime(status.startedAt)}`, modeLine(status), ...pendingLines(status)].join('\n');
    }
}

/**
 * `admin restart [--yes] [--reason <text>]`: restarts the server (`server:restart`). Server commands cannot ask,
 * so without `--yes` it prints what is pending and how to confirm. `admin restart status` needs only `admin:access`.
 */
export class AdminRestartProcessor extends CliCommandProcessor {
    command = 'restart';
    description = 'Restarts the server (needs --yes and server:restart); restart status shows the changes waiting for it';
    parameters = [
        new CliCommandParameterDescriptor('yes', 'Restart now (without it, only shows what is pending)', false, 'boolean', ['y']),
        new CliCommandParameterDescriptor('reason', 'Why, kept in the audit log', false, 'string'),
    ];
    examples = [
        { command: 'admin restart', description: 'What is pending, and how to confirm' },
        { command: 'admin restart --yes --reason "apply CORS"', description: 'Restart now' },
        { command: 'admin restart status', description: 'Mode, supervisor, start time, pending changes' },
    ];
    processors: ICliCommandProcessor[];

    constructor(private readonly restart: ICliServerRestart) {
        super();
        this.processors = [new AdminRestartStatusProcessor(restart)];
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const status = this.restart.status();
        const caller = getCliCaller();
        // Checked here, not as requiredPermissions: `admin restart status` needs only admin:access
        if (caller && !hasCliPermission(caller.permissions, CLI_SERVER_RESTART_PERMISSION)) {
            return `Error: forbidden: missing permission ${CLI_SERVER_RESTART_PERMISSION}`;
        }
        if (!status.supported) return [`Error: restart not supported: ${status.reason}`, ...pendingLines(status)].join('\n');
        const yes = command.args?.yes === true || command.args?.y === true || command.args?.yes === 'true';
        if (!yes) {
            return [...pendingLines(status), modeLine(status), 'Run admin restart --yes [--reason "<why>"] to restart the server now.'].join('\n');
        }
        const reason = command.args?.reason;
        try {
            const result = await this.restart.restart({
                ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
                ...(caller ? { actor: { userId: caller.userId, userName: caller.userName } } : {}),
                via: 'command',
            });
            const applied = result.pending.length ? ` to apply ${result.pending.length} pending change(s)` : '';
            return `Restarting the server${applied} (${status.mode} mode). The connection drops and comes back once it runs again.`;
        } catch (err) {
            return `Error: ${(err as Error)?.message ?? err}`;
        }
    }
}
