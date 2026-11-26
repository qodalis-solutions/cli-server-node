import * as childProcess from 'child_process';
import * as fs from 'fs';
import type { Server } from 'http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
    CLI_SERVER_RESTART_AUDIT_EVENT,
    CLI_SERVER_RESTART_REQUIRED_EVENT,
    CLI_SERVER_RESTARTING_EVENT,
    CliServerRestartError,
    type AuditEntry,
    type CliRestartRequirement,
    type CliRestartRequirementInput,
    type CliServerRestartMode,
    type CliServerRestartRequest,
    type CliServerRestartStatus,
    type CliServerSupervisor,
    type ICliEventBus,
    type ICliServerRestart,
} from '@qodalis/cli-server-abstractions';
import { createLogger } from '../utils/logger';

const logger = createLogger('Restart');

/** The permission the restart events are published to (the dashboard's audience). */
const ADMIN_ACCESS = 'admin:access';
/** The exit code of `exit` mode unless `exitCode` says otherwise (EX_TEMPFAIL: "try again"). */
export const DEFAULT_RESTART_EXIT_CODE = 75;
/** How long the graceful shutdown waits for in-flight requests. */
export const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 10_000;
const MAX_REASON_LENGTH = 500;
/** How long one shutdown hook may take. */
const HOOK_TIMEOUT_MS = 10_000;
export const RESTART_NOT_SUPPORTED = 'restart not supported: no supervisor detected; set restart.mode';

/** What the `handler` mode's function receives. */
export interface CliServerRestartContext {
    reason?: string;
    /** The ids of the changes that were pending. */
    pending: string[];
    by: string;
}

/**
 * What the process does, injectable so tests never exit or spawn: exiting, starting the same command
 * again, and reading the environment and files the supervisor detection looks at.
 */
export interface CliServerRestartRuntime {
    env: NodeJS.ProcessEnv;
    exists(path: string): boolean;
    readFile(path: string): string | undefined;
    exit(code: number): void;
    spawn(command: string, args: string[], options: childProcess.SpawnOptions): { unref(): void; pid?: number };
    execPath: string;
    execArgv: string[];
    argv: string[];
    cwd(): string;
}

/** The `restart` option of `createCliServer`. */
export interface CliServerRestartOptions {
    /** Default `auto`: `exit` under a detected supervisor, else not supported. */
    mode?: CliServerRestartMode;
    /** Exit code of `exit` mode (default 75). */
    exitCode?: number;
    /** `handler` mode: runs after the graceful shutdown; it restarts (or exits) the process. */
    handler?: (context: CliServerRestartContext) => void | Promise<void>;
    /**
     * Allow restarting on a server without sign-in (no auth provider protecting it). Default false:
     * the API and the command refuse with 403, since anyone could restart it. `allowAnonymousAdmin`
     * of `createCliServer` allows it too.
     */
    allowAnonymous?: boolean;
    /** How long the graceful shutdown waits for in-flight requests (default 10 s). */
    drainTimeoutMs?: number;
    /** Replaces what the process does (tests). */
    runtime?: Partial<CliServerRestartRuntime>;
}

/** The parts of the server the graceful shutdown closes (set by `createCliServer`). */
export interface CliServerRestartServices {
    eventBus?: () => ICliEventBus | undefined;
    audit?: () => ((entry: AuditEntry) => Promise<void>) | undefined;
    /** True when an auth provider protects the server (callers are signed in). */
    isProtected?: () => boolean;
    /** True when the host lets anonymous callers administer an unprotected server (`allowAnonymousAdmin`). */
    allowAnonymousAdmin?: () => boolean;
    /** Closes the WebSockets (events, logs, shell) with a code and reason. */
    closeSockets?: (code: number, reason: string) => Promise<void>;
}

const defaultRuntime: CliServerRestartRuntime = {
    env: process.env,
    exists: (p) => {
        try {
            return fs.existsSync(p);
        } catch {
            return false;
        }
    },
    readFile: (p) => {
        try {
            return fs.readFileSync(p, 'utf8');
        } catch {
            return undefined;
        }
    },
    exit: (code) => process.exit(code),
    spawn: (command, args, options) => childProcess.spawn(command, args, options),
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    cwd: () => process.cwd(),
};

/**
 * The supervisor this process runs under, from its environment and files: PM2 (`pm_id`), systemd
 * (`INVOCATION_ID`), Kubernetes (`KUBERNETES_SERVICE_HOST`, or `kubepods` in `/proc/1/cgroup`),
 * Docker (`/.dockerenv`, or `docker` in `/proc/1/cgroup`); null for none.
 */
export function detectSupervisor(runtime: Pick<CliServerRestartRuntime, 'env' | 'exists' | 'readFile'>): CliServerSupervisor | null {
    const env = runtime.env;
    if (env.pm_id !== undefined) return 'pm2';
    if (env.INVOCATION_ID) return 'systemd';
    const cgroup = runtime.readFile('/proc/1/cgroup') ?? '';
    if (env.KUBERNETES_SERVICE_HOST || /kubepods/.test(cgroup)) return 'kubernetes';
    if (runtime.exists('/.dockerenv') || /docker/.test(cgroup)) return 'docker';
    return null;
}

/**
 * The server's restart service: the changes waiting for a restart (`markRequired`, `clearRequired`;
 * empty on every start) and the restart itself: audit `server.restart`, event `server:restarting`, then a
 * graceful shutdown (stop accepting, wait for in-flight requests up to 10 s, close every WebSocket with 1012,
 * run the shutdown hooks: job schedulers, plugins' `dispose`, the host's) and the mode's action.
 */
export class CliServerRestart implements ICliServerRestart {
    readonly startedAt = new Date().toISOString();
    private readonly items = new Map<string, CliRestartRequirement>();
    private readonly servers = new Set<Server>();
    private readonly hooks: Array<{ name: string; fn: () => unknown }> = [];
    private options: CliServerRestartOptions = {};
    private services: CliServerRestartServices = {};
    private runtime: CliServerRestartRuntime = defaultRuntime;
    private inFlight = 0;
    private _restarting = false;
    private _completion: Promise<void> | undefined;

    /** Sets the options and the services (`createCliServer` calls it once). */
    configure(options: CliServerRestartOptions | undefined, services: CliServerRestartServices = {}): this {
        this.options = { ...(options ?? {}) };
        if (this.options.mode === 'handler' && typeof this.options.handler !== 'function') {
            throw new Error("restart.mode 'handler' needs restart.handler");
        }
        if (this.options.mode !== undefined && !['auto', 'exit', 'self', 'handler'].includes(this.options.mode)) {
            throw new Error(`invalid restart.mode: ${String(this.options.mode)}`);
        }
        this.services = services;
        this.runtime = { ...defaultRuntime, ...(this.options.runtime ?? {}) };
        return this;
    }

    get restarting(): boolean {
        return this._restarting;
    }

    /** The graceful shutdown and the mode's action of an accepted restart (resolves when done; tests await it). */
    get completion(): Promise<void> | undefined {
        return this._completion;
    }

    /** The HTTP server(s) the graceful shutdown closes (`eventSocketManager.attach(server)` adds it). */
    attachServer(server: Server): void {
        this.servers.add(server);
    }

    /** Runs `fn` during the graceful shutdown, after the sockets closed, in registration order (errors are logged). */
    onShutdown(name: string, fn: () => unknown): void {
        this.hooks.push({ name, fn });
    }

    /** Counts in-flight requests (installed first by `createCliServer`); also learns the HTTP server. */
    readonly trackRequests: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
        const server = (req.socket as unknown as { server?: Server })?.server;
        if (server && typeof server.close === 'function' && typeof (server as Server).closeAllConnections === 'function') {
            this.servers.add(server);
        }
        this.inFlight++;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            this.inFlight--;
        };
        res.once('finish', finish);
        res.once('close', finish);
        next();
    };

    /** The supervisor detected and the mode in effect (null when not supported). */
    private resolveMode(): { mode: CliServerRestartStatus['mode']; supervisor: CliServerSupervisor | null } {
        const supervisor = detectSupervisor(this.runtime);
        const configured = this.options.mode ?? 'auto';
        if (configured === 'auto') return { mode: supervisor ? 'exit' : null, supervisor };
        return { mode: configured, supervisor };
    }

    status(): CliServerRestartStatus {
        const { mode, supervisor } = this.resolveMode();
        return {
            supported: mode !== null,
            mode,
            supervisor,
            ...(mode === null ? { reason: RESTART_NOT_SUPPORTED.replace('restart not supported: ', '') } : {}),
            startedAt: this.startedAt,
            pending: this.pending(),
        };
    }

    pending(): CliRestartRequirement[] {
        return [...this.items.values()].map((item) => ({ ...item }));
    }

    markRequired(requirement: CliRestartRequirementInput): void {
        const { id, source, description } = requirement ?? ({} as CliRestartRequirementInput);
        if (typeof id !== 'string' || !id || typeof source !== 'string' || typeof description !== 'string') {
            throw new Error('markRequired needs an id, a source and a description');
        }
        if (this.items.has(id)) return;
        this.items.set(id, { id, source, description, since: new Date().toISOString() });
        logger.info('Restart required: %s', description);
        this.publishPending();
    }

    clearRequired(id: string): boolean {
        if (!this.items.delete(id)) return false;
        this.publishPending();
        return true;
    }

    private publishPending(): void {
        void this.services.eventBus?.()?.publish(CLI_SERVER_RESTART_REQUIRED_EVENT, { pending: this.pending() }, { permission: ADMIN_ACCESS });
    }

    async restart(request: CliServerRestartRequest = {}): Promise<{ restarting: true; pending: string[] }> {
        const reason = request.reason;
        if (reason !== undefined && reason !== null && typeof reason !== 'string') {
            throw new CliServerRestartError(400, 'reason must be a string');
        }
        if (typeof reason === 'string' && reason.length > MAX_REASON_LENGTH) {
            throw new CliServerRestartError(400, `reason must be at most ${MAX_REASON_LENGTH} characters`);
        }
        const { mode, supervisor } = this.resolveMode();
        if (mode === null) throw new CliServerRestartError(409, RESTART_NOT_SUPPORTED);
        if (!request.actor && !this.services.isProtected?.() && !this.options.allowAnonymous && !this.services.allowAnonymousAdmin?.()) {
            throw new CliServerRestartError(
                403,
                'sign-in required: protect the server (users plugin) or set allowAnonymousAdmin: true (or restart.allowAnonymous)',
            );
        }
        if (this._restarting) throw new CliServerRestartError(409, 'restart already in progress');
        this._restarting = true;

        const by = request.actor?.userName ?? 'anonymous';
        const pending = [...this.items.keys()];
        const text = reason?.trim() || undefined;
        logger.info('Restarting the server (%s mode), asked by %s%s', mode, by, text ? `: ${text}` : '');
        await this.audit({ reason: text, by, pending, mode, supervisor, actor: request.actor, via: request.via });
        await this.services.eventBus?.()?.publish(
            CLI_SERVER_RESTARTING_EVENT,
            { ...(text ? { reason: text } : {}), by, pending, mode },
            { permission: ADMIN_ACCESS },
        );
        // In the background, after the caller answered (its response is an in-flight request the shutdown waits for)
        this._completion = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
            this.run(mode, { reason: text, pending, by }).catch((err) => {
                logger.error('Restart failed: %s', (err as Error)?.message ?? err);
            }),
        );
        return { restarting: true, pending };
    }

    private async audit(entry: {
        reason?: string;
        by: string;
        pending: string[];
        mode: string;
        supervisor: CliServerSupervisor | null;
        actor?: CliServerRestartRequest['actor'];
        via?: string;
    }): Promise<void> {
        const sink = this.services.audit?.();
        if (!sink) return;
        try {
            await sink({
                timestamp: Date.now(),
                event: CLI_SERVER_RESTART_AUDIT_EVENT,
                username: entry.by,
                ...(entry.actor?.userId ? { userId: entry.actor.userId, actorId: entry.actor.userId } : {}),
                actor: entry.by,
                target: 'server',
                details: entry.reason ?? (entry.pending.length ? `pending: ${entry.pending.join(', ')}` : 'restart'),
                properties: {
                    ...(entry.reason ? { reason: entry.reason } : {}),
                    by: entry.by,
                    pending: entry.pending,
                    mode: entry.mode,
                    ...(entry.supervisor ? { supervisor: entry.supervisor } : {}),
                    ...(entry.via ? { via: entry.via } : {}),
                },
            });
        } catch (err) {
            logger.error('Auditing the restart failed: %s', (err as Error)?.message ?? err);
        }
    }

    /** The graceful shutdown, then the mode's action. */
    private async run(mode: NonNullable<CliServerRestartStatus['mode']>, context: CliServerRestartContext): Promise<void> {
        await this.shutdown();
        if (mode === 'exit') {
            const code = this.options.exitCode ?? DEFAULT_RESTART_EXIT_CODE;
            logger.info('Exiting with code %d for the supervisor to start the server again', code);
            this.runtime.exit(code);
            return;
        }
        if (mode === 'self') {
            this.respawn();
            return;
        }
        await this.options.handler!(context);
    }

    /** Starts the same command again (same arguments, environment, working directory and output), then exits. */
    private respawn(): void {
        const { execPath, execArgv, argv } = this.runtime;
        const args = [...execArgv, ...argv.slice(1)];
        try {
            const child = this.runtime.spawn(execPath, args, {
                cwd: this.runtime.cwd(),
                env: this.runtime.env,
                detached: true,
                // stdout and stderr go where this process writes (a log file, the terminal); never stdin
                stdio: ['ignore', 'inherit', 'inherit'],
            });
            child.unref();
            logger.info('Started the server again (pid %s); this process exits', String(child.pid ?? '?'));
            this.runtime.exit(0);
        } catch (err) {
            logger.error('Starting the server again failed: %s', (err as Error)?.message ?? err);
            this.runtime.exit(1);
        }
    }

    /**
     * Stops accepting connections, waits for the in-flight requests (up to `drainTimeoutMs`), closes every
     * WebSocket with 1012, drops the remaining connections and runs the shutdown hooks.
     */
    async shutdown(): Promise<void> {
        const closed = [...this.servers].map(
            (server) =>
                new Promise<void>((resolve) => {
                    if (!server.listening) {
                        resolve();
                        return;
                    }
                    server.close(() => resolve());
                    server.closeIdleConnections?.();
                }),
        );
        const deadline = Date.now() + (this.options.drainTimeoutMs ?? DEFAULT_RESTART_DRAIN_TIMEOUT_MS);
        while (this.inFlight > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
        }
        if (this.inFlight > 0) logger.warn('%d request(s) still running after the drain timeout', this.inFlight);
        try {
            await this.services.closeSockets?.(1012, 'Server restarting');
        } catch (err) {
            logger.error('Closing the WebSockets failed: %s', (err as Error)?.message ?? err);
        }
        for (const server of this.servers) server.closeAllConnections?.();
        await Promise.race([Promise.all(closed), new Promise((r) => setTimeout(r, 2000).unref())]);
        for (const hook of this.hooks) {
            try {
                await Promise.race([
                    Promise.resolve().then(hook.fn),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), HOOK_TIMEOUT_MS).unref()),
                ]);
            } catch (err) {
                logger.error('Shutdown step %s failed: %s', hook.name, (err as Error)?.message ?? err);
            }
        }
    }
}
