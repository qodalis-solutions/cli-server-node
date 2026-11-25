/**
 * Restarting the server from the dashboard, the `admin restart` command or the API
 * (`/api/v1/qcli/server/restart`), and the list of changes waiting for a restart.
 * The server implements {@link ICliServerRestart} (`builder.restart`); plugins mark
 * their own pending changes with `markRequired`.
 */

/** The permission `POST /api/v1/qcli/server/restart` and `admin restart` need. */
export const CLI_SERVER_RESTART_PERMISSION = 'server:restart';
/** Published when the pending list changes (`{ pending }`, audience `admin:access`). */
export const CLI_SERVER_RESTART_REQUIRED_EVENT = 'server:restart-required';
/** Published when a restart starts (`{ reason, by, pending, mode }`, audience `admin:access`). */
export const CLI_SERVER_RESTARTING_EVENT = 'server:restarting';
/** The audit event of a restart. */
export const CLI_SERVER_RESTART_AUDIT_EVENT = 'server.restart';
/** The WebSocket close code sent to every socket when the server restarts (RFC 6455: service restart). */
export const CLI_SERVER_RESTART_CLOSE_CODE = 1012;

/**
 * How the server restarts:
 * - `exit`: graceful shutdown, then exit with `exitCode` (default 75) for a supervisor to start it again
 *   (Docker restart policy, systemd `Restart=always`, PM2, Kubernetes);
 * - `self`: graceful shutdown, then the same command is started again (same arguments, environment, working
 *   directory and output) and this process exits: bare runs and development;
 * - `handler`: graceful shutdown, then the host's function;
 * - `auto` (default): `exit` when a supervisor is detected, otherwise restarting is not supported.
 */
export type CliServerRestartMode = 'auto' | 'exit' | 'self' | 'handler';

/** A supervisor that starts the process again when it exits. */
export type CliServerSupervisor = 'docker' | 'systemd' | 'pm2' | 'kubernetes';

/** A change that takes effect only after a restart, as `markRequired` takes it. */
export interface CliRestartRequirementInput {
    /** Unique key: marking the same id again keeps the first entry (e.g. `config:cors.cors.mode`). */
    id: string;
    /** Who marked it: `config`, a plugin's id, ... */
    source: string;
    /** One line for people: `CORS: Mode changed`. */
    description: string;
}

/** A pending change as listed by the API. */
export interface CliRestartRequirement extends CliRestartRequirementInput {
    /** When it was marked (ISO 8601). */
    since: string;
}

/** `GET /api/v1/qcli/server/restart`. */
export interface CliServerRestartStatus {
    /** The server can restart itself (from the dashboard, the command or the API). */
    supported: boolean;
    /** The mode in effect (`auto` resolves to `exit`); null when not supported. */
    mode: Exclude<CliServerRestartMode, 'auto'> | null;
    /** The supervisor detected, also with an explicit mode; null when none. */
    supervisor: CliServerSupervisor | null;
    /** Why it is not supported (only when `supported` is false). */
    reason?: string;
    /** When this process started serving (ISO 8601): it changes once the server restarted. */
    startedAt: string;
    /** Changes waiting for a restart, oldest first; empty after every start. */
    pending: CliRestartRequirement[];
}

/** Who asks for a restart, and why. */
export interface CliServerRestartRequest {
    /** Free text kept in the audit log (at most 500 characters). */
    reason?: string;
    /** The signed-in caller; absent on a server without sign-in. */
    actor?: { userId?: string; userName: string };
    /** Where it came from: `api`, `command`, ... (audited). */
    via?: string;
}

/** A refused restart: 409 not supported or already restarting, 403 without sign-in, 400 bad input. */
export class CliServerRestartError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'CliServerRestartError';
    }
}

/** The server's restart service (`builder.restart` / `createCliServer().restart`). */
export interface ICliServerRestart {
    /** When this process started serving (ISO 8601). */
    readonly startedAt: string;
    /** True once a restart was accepted. */
    readonly restarting: boolean;
    status(): CliServerRestartStatus;
    /** The pending changes (copies), oldest first. */
    pending(): CliRestartRequirement[];
    /** Adds a pending change (nothing happens when the id is already pending); publishes `server:restart-required`. */
    markRequired(requirement: CliRestartRequirementInput): void;
    /** Removes a pending change (e.g. a setting set back to its value at start); true when it was pending. */
    clearRequired(id: string): boolean;
    /**
     * Accepts a restart: audits it, publishes `server:restarting` and resolves; the graceful shutdown and the
     * mode's action follow in the background. Rejects with {@link CliServerRestartError}.
     */
    restart(request?: CliServerRestartRequest): Promise<{ restarting: true; pending: string[] }>;
}
