import { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../utils/logger';
import {
    CliServerAuthContext,
    CliServerPermissions,
    CliServerSessionEvent,
    ICliServerAuth,
    clientAddress,
} from '../auth/cli-server-auth';
import {
    CliShellAuthMode,
    CliShellOptions,
    SHELL_DEFAULTS,
    ShellCloseCodes,
    buildShellEnv,
    readBearerToken,
    resolveShellAuthMode,
    tokensEqual,
} from './cli-shell-options';
import { terminateProcessTree } from './process-tree';

const logger = createLogger('ShellSession');

/** Longest delay `setTimeout` supports (~24.8 days); longer ones fire immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Lazy-loads node-pty to avoid import failures when the native add-on is unavailable.
 * @throws {Error} If node-pty cannot be loaded.
 */
let _pty: typeof import('node-pty') | undefined;
function getPty(): typeof import('node-pty') {
    if (!_pty) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            _pty = require('node-pty');
        } catch (err: any) {
            throw new Error(
                `node-pty is required for shell sessions but failed to load: ${err.message}`,
            );
        }
    }
    return _pty!;
}

/** Messages sent from the WebSocket client to the shell session. */
type ClientMessage =
    | { type: 'stdin'; data: string }
    | { type: 'resize'; cols: number; rows: number };

/** Messages sent from the shell session to the WebSocket client. */
type ServerMessage =
    | { type: 'stdout'; data: string }
    | { type: 'stderr'; data: string }
    | { type: 'exit'; code: number }
    | { type: 'error'; message: string }
    | { type: 'ready'; shell: string; os: string };

/** Public view of an open shell session. */
export interface CliShellSessionInfo {
    id: string;
    authMode: CliShellAuthMode;
    mode: 'interactive' | 'command';
    remoteAddress: string;
    userId?: string;
    userName?: string;
    sessionId?: string;
    startedAt: string;
}

interface ShellSession {
    id: string;
    ws: WebSocket;
    authMode: CliShellAuthMode;
    mode: 'interactive' | 'command';
    remoteAddress: string;
    /** Limit bucket: user id (users mode) or remote address. */
    limitKey: string;
    ctx?: CliServerAuthContext;
    /** Original upgrade request (re-authenticates adapter identities on re-checks). */
    request: IncomingMessage;
    startedAt: number;
    lastInput: number;
    /** Stdin received since the last session re-check (counts as session activity). */
    inputSinceCheck: boolean;
    lastTouch: number;
    pty?: import('node-pty').IPty;
    idleTimer?: NodeJS.Timeout;
    durationTimer?: NodeJS.Timeout;
    closed: boolean;
}

interface AccessDecision {
    ok: boolean;
    code?: number;
    reason?: string;
    ctx?: CliServerAuthContext;
}

/**
 * Manages interactive PTY shell sessions over WebSocket connections and
 * enforces Appendix C: access mode, session binding, limits, timeouts,
 * minimal environment and audit.
 */
export class CliShellSessionManager {
    private _options: CliShellOptions;
    private _enabled: boolean;
    private _auth?: ICliServerAuth;
    private _unsubscribe?: () => void;
    private readonly _sessions = new Set<ShellSession>();
    private _nextId = 1;
    private _checkTimer?: NodeJS.Timeout;

    private _trustProxy: boolean | number;

    constructor(options: { enabled?: boolean; shell?: CliShellOptions; trustProxy?: boolean | number } = {}) {
        this._enabled = options.enabled ?? false;
        this._options = options.shell ?? {};
        this._trustProxy = options.trustProxy ?? false;
    }

    /**
     * Trusted reverse-proxy hops (`true` = 1): the remote address is the
     * `X-Forwarded-For` entry at index `len - hops` (`false`/0: the socket address).
     */
    setTrustProxy(trust: boolean | number): void {
        this._trustProxy = trust;
    }

    get enabled(): boolean {
        return this._enabled;
    }

    setEnabled(enabled: boolean): void {
        this._enabled = enabled;
    }

    get options(): CliShellOptions {
        return this._options;
    }

    setOptions(options: CliShellOptions): void {
        this._options = options ?? {};
    }

    /** Current access mode (`undefined` while the shell is disabled). */
    get authMode(): CliShellAuthMode | undefined {
        return this._enabled ? resolveShellAuthMode(this._options, !!this._auth) : undefined;
    }

    /** Installs the auth provider (users plugin); subscribes to its session events. */
    setAuth(auth: ICliServerAuth | undefined): void {
        if (auth === this._auth) return;
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._auth = auth;
        if (auth?.onSessionEvent) {
            this._unsubscribe = auth.onSessionEvent((event) => this.onSessionEvent(event));
        }
    }

    /** Logs the startup state: ERROR when locked, WARNING when anonymous. */
    logStartupState(): void {
        const mode = this.authMode;
        if (mode === 'locked') {
            logger.error(
                'Shell is enabled but no access mode is configured, so it is LOCKED (every connection is refused). ' +
                    'Mount the users plugin (shell:execute permission), or set shell.token, shell.authorize, ' +
                    'or shell.allowAnonymous (not recommended).',
            );
        } else if (mode === 'anonymous') {
            logger.warn('WARNING: shell is enabled without authentication (shell.allowAnonymous). Anyone who can reach this server gets a shell.');
        } else if (mode) {
            logger.info('Shell enabled (auth=%s)', mode);
        }
    }

    /** Open sessions. */
    getSessions(): CliShellSessionInfo[] {
        return [...this._sessions].map((s) => ({
            id: s.id,
            authMode: s.authMode,
            mode: s.mode,
            remoteAddress: s.remoteAddress,
            userId: s.ctx?.userId,
            userName: s.ctx?.userName,
            sessionId: s.ctx?.sessionId,
            startedAt: new Date(s.startedAt).toISOString(),
        }));
    }

    /**
     * Takes over an accepted shell WebSocket: authorizes it (closing with
     * 4401/4403/4404/4429 when refused), then bridges it to a PTY.
     */
    async accept(ws: WebSocket, request: IncomingMessage, url: URL): Promise<void> {
        if (!this._enabled) {
            ws.close(ShellCloseCodes.Disabled, 'shell disabled');
            return;
        }
        const cols = clampDim(url.searchParams.get('cols'), 80);
        const rows = clampDim(url.searchParams.get('rows'), 24);
        const command = url.searchParams.get('cmd') || undefined;
        const mode: 'interactive' | 'command' = command ? 'command' : 'interactive';
        const remoteAddress = this.remoteAddressOf(request);
        const authMode = resolveShellAuthMode(this._options, !!this._auth);

        let decision: AccessDecision;
        try {
            decision = await this.authorize(authMode, request, url, remoteAddress, mode);
        } catch {
            decision = { ok: false, code: ShellCloseCodes.Forbidden, reason: 'forbidden' };
        }
        if (!decision.ok) {
            closeWs(ws, decision.code!, decision.reason!);
            return;
        }
        if (ws.readyState !== WebSocket.OPEN) return;

        const limitKey = authMode === 'users' ? `user:${decision.ctx!.userId}` : `addr:${remoteAddress}`;
        const perUser = this._options.maxSessionsPerUser ?? SHELL_DEFAULTS.maxSessionsPerUser;
        const total = this._options.maxSessions ?? SHELL_DEFAULTS.maxSessions;
        let sameKey = 0;
        for (const s of this._sessions) if (s.limitKey === limitKey) sameKey++;
        if (sameKey >= perUser || this._sessions.size >= total) {
            closeWs(ws, ShellCloseCodes.TooMany, 'too many shell sessions');
            return;
        }

        const now = Date.now();
        const session: ShellSession = {
            id: `sh-${this._nextId++}`,
            ws,
            authMode,
            mode,
            remoteAddress,
            limitKey,
            ctx: decision.ctx,
            request,
            startedAt: now,
            lastInput: now,
            inputSinceCheck: false,
            lastTouch: 0,
            closed: false,
        };
        this._sessions.add(session);
        this.ensureCheckTimer();
        this.spawn(session, cols, rows, command);
    }

    /** Decides access for the given mode. */
    private async authorize(
        authMode: CliShellAuthMode,
        request: IncomingMessage,
        url: URL,
        remoteAddress: string,
        mode: 'interactive' | 'command',
    ): Promise<AccessDecision> {
        const o = this._options;
        if (authMode === 'locked') {
            return { ok: false, code: ShellCloseCodes.LoginRequired, reason: 'shell access is not configured' };
        }

        let ctx: CliServerAuthContext | undefined;
        if (authMode === 'users') {
            const ticket = url.searchParams.get('ticket');
            try {
                ctx = ticket ? await this._auth!.consumeTicket(ticket) : undefined;
            } catch (err: any) {
                if (err?.status === 403) {
                    return { ok: false, code: ShellCloseCodes.Forbidden, reason: 'forbidden' };
                }
                ctx = undefined;
            }
            if (!ctx) {
                return { ok: false, code: ShellCloseCodes.LoginRequired, reason: 'login required' };
            }
            if (!this._auth!.hasPermission(ctx, CliServerPermissions.ShellExecute)) {
                return { ok: false, code: ShellCloseCodes.Forbidden, reason: 'forbidden' };
            }
        }

        // Every configured check among token/authorize must pass, whatever the mode.
        if (o.token) {
            const presented = readBearerToken(request, url);
            if (!presented) {
                return { ok: false, code: ShellCloseCodes.LoginRequired, reason: 'login required' };
            }
            if (!tokensEqual(presented, o.token)) {
                return { ok: false, code: ShellCloseCodes.Forbidden, reason: 'forbidden' };
            }
        }

        if (o.authorize) {
            let allowed = false;
            try {
                allowed = (await o.authorize(request, { url, remoteAddress, mode })) === true;
            } catch (err: any) {
                logger.warn('Shell authorize callback threw; denying (%s)', err?.message ?? 'error');
                allowed = false;
            }
            if (!allowed) {
                return { ok: false, code: ShellCloseCodes.Forbidden, reason: 'forbidden' };
            }
        }

        return { ok: true, ctx };
    }

    private spawn(session: ShellSession, cols: number, rows: number, command?: string): void {
        const { ws } = session;
        const { shell, args } = this.getShellInfo(command);

        let nodePty: typeof import('node-pty');
        try {
            nodePty = getPty();
        } catch (err: any) {
            logger.error('node-pty unavailable: %s', err.message ?? err);
            this.send(ws, { type: 'error', message: 'shell is not available on this server' });
            this.end(session, 1011, 'shell unavailable', 'error');
            return;
        }

        try {
            session.pty = nodePty.spawn(shell, args, {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: this._options.cwd ?? os.homedir(),
                env: buildShellEnv(this._options.env, { shell, cols, rows }),
            });
        } catch (err: any) {
            logger.error('Shell spawn failed: %s', err.message ?? err);
            this.send(ws, { type: 'error', message: 'failed to start shell' });
            this.end(session, 1011, 'shell failed', 'error');
            return;
        }

        this.onOpened(session);

        this.send(ws, {
            type: 'ready',
            shell: path.basename(shell),
            os: os.platform() === 'win32' ? 'win32' : os.platform() === 'darwin' ? 'darwin' : 'linux',
        });

        session.pty.onData((data) => this.send(ws, { type: 'stdout', data }));
        session.pty.onExit(({ exitCode }) => {
            if (session.closed) return;
            this.send(ws, { type: 'exit', code: exitCode });
            this.end(session, 1000, 'exit', 'exited', exitCode);
        });

        ws.on('message', (raw) => {
            let msg: ClientMessage;
            try {
                msg = JSON.parse(raw.toString()) as ClientMessage;
            } catch {
                logger.debug('Ignoring malformed WebSocket message');
                return;
            }
            try {
                if (msg.type === 'stdin' && typeof msg.data === 'string') {
                    session.lastInput = Date.now();
                    session.inputSinceCheck = true;
                    session.pty?.write(msg.data);
                } else if (msg.type === 'resize') {
                    session.pty?.resize(clampDim(String(msg.cols), cols), clampDim(String(msg.rows), rows));
                }
            } catch {
                logger.debug('Ignoring shell message after exit');
            }
        });

        ws.on('close', () => this.end(session, undefined, undefined, 'closed'));
        ws.on('error', (error) => {
            logger.error('Shell socket error: %s', (error as Error).message ?? error);
            this.end(session, undefined, undefined, 'error');
        });

        this.armTimers(session);
    }

    /** Idle (no stdin) and absolute duration timers ⇒ 4408. */
    private armTimers(session: ShellSession): void {
        const idle = this._options.idleTimeoutMs ?? SHELL_DEFAULTS.idleTimeoutMs;
        if (idle > 0) {
            const check = () => {
                if (session.closed) return;
                const remaining = session.lastInput + idle - Date.now();
                if (remaining <= 0) {
                    this.end(session, ShellCloseCodes.TimedOut, 'shell timed out', 'shell timed out');
                } else {
                    session.idleTimer = setTimeout(check, Math.min(remaining, MAX_TIMEOUT_MS));
                    session.idleTimer.unref?.();
                }
            };
            session.idleTimer = setTimeout(check, Math.min(idle, MAX_TIMEOUT_MS));
            session.idleTimer.unref?.();
        }
        const max = this._options.maxDurationMs;
        if (max && max > 0) {
            const deadline = Date.now() + max;
            const expire = () => {
                if (session.closed) return;
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    this.end(session, ShellCloseCodes.TimedOut, 'shell timed out', 'shell timed out');
                } else {
                    session.durationTimer = setTimeout(expire, Math.min(remaining, MAX_TIMEOUT_MS));
                    session.durationTimer.unref?.();
                }
            };
            session.durationTimer = setTimeout(expire, Math.min(max, MAX_TIMEOUT_MS));
            session.durationTimer.unref?.();
        }
    }

    // ----------------------------------------------------- session binding

    private onSessionEvent(event: CliServerSessionEvent): void {
        if (event.type === 'session-ended') {
            for (const s of [...this._sessions]) {
                if (s.ctx?.sessionId && s.ctx.sessionId === event.sessionId) {
                    this.end(s, ShellCloseCodes.LoginRequired, 'session ended', 'session ended');
                }
            }
        } else {
            void this.recheck(event.userId);
        }
    }

    private ensureCheckTimer(): void {
        if (this._checkTimer || !this._auth) return;
        const interval = Math.min(
            Math.max(this._options.sessionCheckIntervalMs ?? SHELL_DEFAULTS.sessionCheckIntervalMs, 10),
            SHELL_DEFAULTS.maxSessionCheckIntervalMs,
        );
        this._checkTimer = setInterval(() => void this.recheck(), interval);
        this._checkTimer.unref?.();
    }

    private stopCheckTimerIfIdle(): void {
        if (this._checkTimer && ![...this._sessions].some((s) => s.ctx)) {
            clearInterval(this._checkTimer);
            this._checkTimer = undefined;
        }
    }

    /**
     * Re-validates users-mode shells: session alive, user enabled, still holding
     * `shell:execute` (identities from a host auth adapter are re-authenticated
     * from the original upgrade request). Otherwise the shell is closed with 4401
     * `session ended` (audit reason `session ended` or `permission removed`).
     * The check itself never extends the session; stdin received since the
     * previous check touches it first (at most once per 30 s).
     */
    async recheck(userId?: string): Promise<void> {
        const auth = this._auth;
        for (const s of [...this._sessions]) {
            if (s.closed || !s.ctx || (userId && s.ctx.userId !== userId)) continue;
            let fresh: CliServerAuthContext | undefined = s.ctx;
            const now = Date.now();
            const typed = s.inputSinceCheck;
            s.inputSinceCheck = false;
            try {
                if (typed && auth?.touch && now - s.lastTouch >= SHELL_DEFAULTS.touchIntervalMs) {
                    s.lastTouch = now;
                    await auth.touch(s.ctx);
                }
                fresh = auth?.revalidate ? await auth.revalidate(s.ctx, s.request) : s.ctx;
            } catch {
                fresh = undefined;
            }
            if (s.closed) continue;
            if (!fresh || !auth || !auth.hasPermission(fresh, CliServerPermissions.ShellExecute)) {
                this.end(s, ShellCloseCodes.LoginRequired, 'session ended', fresh ? 'permission removed' : 'session ended');
            } else {
                s.ctx = { ...s.ctx, permissions: fresh.permissions };
            }
        }
    }

    // ------------------------------------------------------------ lifecycle

    private onOpened(session: ShellSession): void {
        if (session.authMode === 'users' && session.ctx) {
            this.audit(session, 'shell_opened', {});
        } else {
            logger.info('Shell opened (id=%s, auth=%s, mode=%s, remote=%s)', session.id, session.authMode, session.mode, session.remoteAddress);
        }
    }

    /**
     * Ends a session once (`why` is the audit reason: exited | closed | session ended |
     * permission removed | shell timed out | server shutdown | error): kills the process tree, closes the socket with the
     * given code (when still open) and audits/logs the close.
     */
    private end(session: ShellSession, code: number | undefined, reason: string | undefined, why: string, exitCode?: number): void {
        if (session.closed) return;
        session.closed = true;
        this._sessions.delete(session);
        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (session.durationTimer) clearTimeout(session.durationTimer);
        this.stopCheckTimerIfIdle();

        if (session.pty) {
            killTree(session.pty);
        }
        if (code !== undefined) {
            closeWs(session.ws, code, reason ?? '');
        }

        if (!session.pty) return; // never opened
        const durationMs = Date.now() - session.startedAt;
        if (session.authMode === 'users' && session.ctx) {
            this.audit(session, 'shell_closed', { durationMs, reason: why, ...(why === 'exited' ? { exitCode } : {}) });
        } else {
            logger.info(
                'Shell closed (id=%s, auth=%s, mode=%s, remote=%s, reason=%s, durationMs=%d)',
                session.id, session.authMode, session.mode, session.remoteAddress, why, durationMs,
            );
        }
    }

    private audit(session: ShellSession, event: 'shell_opened' | 'shell_closed', extra: Record<string, unknown>): void {
        const ctx = session.ctx!;
        const audit = this._auth?.audit;
        if (!audit) return;
        audit
            .call(this._auth, {
                event,
                userId: ctx.userId,
                userName: ctx.userName,
                actorId: ctx.userId,
                actorName: ctx.userName,
                metadata: {
                    mode: session.mode,
                    sessionId: ctx.sessionId,
                    remoteAddress: session.remoteAddress,
                    ...extra,
                },
            })
            .catch((err) => logger.error('Shell audit failed: %s', err?.message ?? err));
    }

    /** Closes every open shell (server shutdown). */
    dispose(): void {
        for (const s of [...this._sessions]) {
            this.end(s, 1001, 'server shutdown', 'server shutdown');
        }
        if (this._checkTimer) clearInterval(this._checkTimer);
        this._checkTimer = undefined;
        this._unsubscribe?.();
        this._unsubscribe = undefined;
    }

    // -------------------------------------------------------------- helpers

    private remoteAddressOf(request: IncomingMessage): string {
        return clientAddress(request, this._trustProxy);
    }

    /** Determines the shell binary and arguments based on options, platform and optional command. */
    private getShellInfo(command?: string): { shell: string; args: string[] } {
        if (os.platform() === 'win32') {
            const shell = this._options.shell ?? 'powershell.exe';
            return command ? { shell, args: ['-Command', command] } : { shell, args: [] };
        }
        const shell = this._options.shell ?? detectShell();
        return command ? { shell, args: ['-c', command] } : { shell, args: [] };
    }

    /** Sends a JSON message to the WebSocket if the connection is open. */
    private send(ws: WebSocket, msg: ServerMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
}

/** Detects the best available shell on Unix systems by checking $SHELL and common paths. */
function detectShell(): string {
    const candidates = [process.env.SHELL, '/bin/bash', '/usr/bin/bash', '/bin/sh'].filter(Boolean) as string[];
    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            continue;
        }
    }
    return '/bin/sh';
}

function clampDim(value: string | null, fallback: number): number {
    const n = parseInt(value ?? '', 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, 1000);
}

function closeWs(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
            ws.close(code, reason);
        } catch {
            ws.terminate();
        }
    }
}

/**
 * Kills the shell and everything it started. Unix: the descendant tree is
 * collected before signalling (background jobs in their own process groups,
 * `setsid`/`nohup` children), then HUP → TERM → (grace) → KILL.
 */
function killTree(pty: import('node-pty').IPty): void {
    if (os.platform() !== 'win32') {
        terminateProcessTree(pty.pid);
        return;
    }
    try {
        pty.kill();
    } catch {
        // already exited
    }
}
