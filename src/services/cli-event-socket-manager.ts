import { WebSocket, WebSocketServer } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { URL } from 'url';
import { CliShellSessionManager } from './cli-shell-session-manager';
import { CliShellAuthMode, CliShellOptions } from './cli-shell-options';
import { createLogger } from '../utils/logger';
import { CliServerAuthContext, ICliServerAuth } from '../auth/cli-server-auth';
import { authorizeWsUpgrade, rejectUpgrade } from '../auth/ws-upgrade-auth';
import { SessionBoundSockets } from './session-bound-sockets';
import { CliEvent, CliEventAudience, CliEventPermissions, toCliEventMessage } from '@qodalis/cli-server-abstractions';

const logger = createLogger('EventSocket');

/** Information about a connected WebSocket event client. */
export interface CliWebSocketClientInfo {
    id: string;
    connectedAt: string;
    remoteAddress: string;
    type: 'events';
}

interface ClientEntry {
    id: string;
    connectedAt: Date;
    remoteAddress: string;
    /** Identity from a WS ticket, when one was presented. */
    auth?: CliServerAuthContext;
}

export interface CliEventSocketManagerOptions {
    /** Accept interactive shell sessions on `/ws/v1/qcli/shell` (default false). */
    enableShell?: boolean;
    /** Shell security options (access mode, limits, timeouts, environment). */
    shell?: CliShellOptions;
    /**
     * Trusted reverse-proxy hops (`true` = 1, `false`/0 = none) for `X-Forwarded-*`
     * headers (shell per-address limits/logs, same-origin checks).
     */
    trustProxy?: boolean | number;
    /** When set, every upgrade with an `Origin` header must come from one of these. */
    allowedOrigins?: string[];
}

/** Events delivered only to sockets authenticated as the event's user. */
const USER_SCOPED_EVENTS = new Set(['session-kicked']);

/** Read permission per event namespace, for raw messages sent with {@link CliEventSocketManager.broadcastMessage}. */
const NAMESPACE_PERMISSIONS: Record<string, string> = {
    log: CliEventPermissions.LogsRead,
    job: CliEventPermissions.JobsRead,
    user: CliEventPermissions.UsersRead,
    group: CliEventPermissions.GroupsRead,
    token: CliEventPermissions.TokensRead,
    session: CliEventPermissions.SessionsRead,
    fs: CliEventPermissions.FilesRead,
    command: CliEventPermissions.AuditRead,
    audit: CliEventPermissions.AuditRead,
};

/** The audience of a raw message: by its namespace (`token:*` also reaches the token's owner). */
function defaultAudience(type: string, message: Record<string, unknown>): CliEventAudience {
    const namespace = type === 'log' ? 'log' : type.split(':', 1)[0];
    const permission = type.includes(':') || type === 'log' ? NAMESPACE_PERMISSIONS[namespace] : undefined;
    if (!permission) return {};
    if (namespace === 'token' && typeof message.userId === 'string') {
        return { permission, userId: message.userId };
    }
    return { permission };
}

/**
 * Manages WebSocket connections for server-push events and interactive shell sessions.
 * Handles upgrades on `/ws/v1/qcli/events` and (when `enableShell` is set)
 * `/ws/v1/qcli/shell`. With an auth provider that protects the server, event
 * upgrades need a single-use `?ticket=`; `session-kicked` is delivered only to
 * the affected user. Sockets authenticated with a stored session are bound to
 * it: once it ends they are closed with 4401 `session ended` (after
 * `session-kicked` for revocations; see {@link SessionBoundSockets}); sockets
 * opened through an external auth adapter are re-checked through it every
 * `shell.sessionCheckIntervalMs` (default 30 s, at most 60 s). Shell
 * access (modes, limits, session binding) is decided by {@link CliShellSessionManager}.
 */
export class CliEventSocketManager {
    private _wss: WebSocketServer | null = null;
    private readonly _clients = new Set<WebSocket>();
    private readonly _clientMeta = new Map<WebSocket, ClientEntry>();
    private readonly _shellManager: CliShellSessionManager;
    private _nextClientId = 1;
    private _auth?: ICliServerAuth;
    private _allowedOrigins?: string[];
    private readonly _trustProxy: boolean | number;
    private readonly _sessionBound: SessionBoundSockets;

    constructor(options: CliEventSocketManagerOptions = {}) {
        this._sessionBound = new SessionBoundSockets({
            awaitKick: true,
            sessionCheckIntervalMs: options.shell?.sessionCheckIntervalMs,
        });
        this._shellManager = new CliShellSessionManager({
            enabled: options.enableShell ?? false,
            shell: options.shell,
            trustProxy: options.trustProxy,
        });
        this._allowedOrigins = options.allowedOrigins;
        this._trustProxy = options.trustProxy ?? false;
    }

    /** Installs the auth provider (users plugin) used to authenticate upgrades with tickets. */
    setAuth(auth: ICliServerAuth | undefined): void {
        this._auth = auth;
        this._shellManager.setAuth(auth);
        this._sessionBound.setAuth(auth);
    }

    setAllowedOrigins(origins: string[] | undefined): void {
        this._allowedOrigins = origins;
    }

    setShellEnabled(enabled: boolean): void {
        this._shellManager.setEnabled(enabled);
    }

    get shellEnabled(): boolean {
        return this._shellManager.enabled;
    }

    /** Shell access mode (`undefined` while the shell is disabled). */
    get shellAuthMode(): CliShellAuthMode | undefined {
        return this._shellManager.authMode;
    }

    /** The shell session manager (open sessions, limits, binding). */
    get shellManager(): CliShellSessionManager {
        return this._shellManager;
    }

    private static readonly EVENT_PATHS = new Set([
        '/ws/v1/qcli/events',
        '/ws/qcli/events',
    ]);

    private static readonly SHELL_PATHS = new Set([
        '/ws/v1/qcli/shell',
        '/ws/qcli/shell',
    ]);

    /**
     * Attach to an HTTP server and listen for WebSocket upgrades on
     * event and shell paths.
     */
    attach(server: Server): void {
        this._wss = new WebSocketServer({ noServer: true });
        this._shellManager.logStartupState();

        server.on('upgrade', (request, socket, head) => {
            let parsed: URL;
            try {
                parsed = new URL(request.url ?? '', 'http://localhost');
            } catch {
                return; // malformed request target: not one of our paths
            }
            const pathname = parsed.pathname;

            if (CliEventSocketManager.EVENT_PATHS.has(pathname)) {
                authorizeWsUpgrade(request, parsed, { auth: this._auth, allowedOrigins: this._allowedOrigins, trustProxy: this._trustProxy }).then(
                    (result) => {
                        if (!result.ok) {
                            rejectUpgrade(socket, result.status);
                            return;
                        }
                        this._wss!.handleUpgrade(request, socket, head, (ws) => {
                            this._wss!.emit('connection', ws, request, result.ctx);
                        });
                    },
                    () => rejectUpgrade(socket, 401),
                );
                return;
            }

            if (CliEventSocketManager.SHELL_PATHS.has(pathname)) {
                // Origin rejection stays an HTTP 403; every other refusal is
                // "accept, then close" with a code the browser can read (C5).
                authorizeWsUpgrade(request, parsed, { allowedOrigins: this._allowedOrigins, trustProxy: this._trustProxy }).then((result) => {
                    if (!result.ok) {
                        rejectUpgrade(socket, result.status);
                        return;
                    }
                    this._wss!.handleUpgrade(request, socket, head, (ws) => {
                        this._shellManager.accept(ws, request, parsed).catch((err) => {
                            logger.error('Shell session error: %s', err?.message ?? err);
                            try {
                                ws.close(1011, 'shell error');
                            } catch {
                                // ignore
                            }
                        });
                    });
                });
                return;
            }

            // Unrecognized path; leave for other upgrade handlers
        });

        this._wss.on('connection', (ws, request: IncomingMessage, auth?: CliServerAuthContext) => {
            this._clients.add(ws);
            const id = `evt-${this._nextClientId++}`;
            this._clientMeta.set(ws, {
                id,
                connectedAt: new Date(),
                remoteAddress: request.socket.remoteAddress ?? 'unknown',
                auth,
            });
            this._sessionBound.bind(ws, auth, request);
            logger.info('Client connected (id=%s)', id);
            ws.send(JSON.stringify({ type: 'connected' }));

            const disconnected = () => {
                const meta = this._clientMeta.get(ws);
                logger.info('Client disconnected (id=%s)', meta?.id ?? 'unknown');
                this._sessionBound.unbind(ws);
                this._clients.delete(ws);
                this._clientMeta.delete(ws);
            };
            ws.on('close', disconnected);
            ws.on('error', disconnected);
        });
    }

    /**
     * Broadcast a raw message to the connected event clients (kept for compatibility;
     * publish on the event bus instead). On a protected server a namespaced message
     * reaches the sockets holding its namespace's read permission (`job:*` → `jobs:read`,
     * `user:*` → `users:read`, ...; `token:*` also its owner); others reach every socket.
     */
    broadcastMessage(message: Record<string, unknown>): void {
        const data = JSON.stringify(message);
        const type = typeof message.type === 'string' ? message.type : '';
        const payload = (message.data ?? {}) as Record<string, unknown>;
        const audience = defaultAudience(type, message);
        const toClose: WebSocket[] = [];

        for (const ws of this._clients) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            const auth = this._clientMeta.get(ws)?.auth;

            if (USER_SCOPED_EVENTS.has(type)) {
                // Only the affected user's sockets learn about it
                if (!auth || auth.userId !== payload.userId) continue;
                ws.send(data);
                if (type === 'session-kicked' && auth.sessionId && auth.sessionId === payload.sessionId) {
                    toClose.push(ws);
                }
                continue;
            }

            // A socket whose session ended only waits for its session-kicked
            if (this._sessionBound.isEnding(ws)) continue;

            // Server-wide events need the matching read permission
            if (!this._allows(auth, audience)) continue;

            ws.send(data);
        }

        for (const ws of toClose) {
            this._sessionBound.kicked(ws);
        }
    }

    /**
     * Sends a bus event to the sockets its audience allows (the subscriber of `*`
     * that `createCliServer` installs). Without an auth provider protecting the
     * server, every socket receives every event.
     */
    deliverEvent(event: CliEvent): void {
        const message = toCliEventMessage(event);
        if (USER_SCOPED_EVENTS.has(event.type)) {
            // Control message with its own delivery rules (and socket closing)
            this.broadcastMessage(message);
            return;
        }
        this._send(message, event.audience);
    }

    /** Sends `message` to every open socket the audience allows (sockets of ended sessions excepted). */
    private _send(message: Record<string, unknown>, audience: CliEventAudience): void {
        const data = JSON.stringify(message);
        for (const ws of this._clients) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            // A socket whose session ended only waits for its session-kicked
            if (this._sessionBound.isEnding(ws)) continue;
            if (!this._allows(this._clientMeta.get(ws)?.auth, audience)) continue;
            try {
                ws.send(data);
            } catch {
                // A closing socket: never log here (log entries are events too)
            }
        }
    }

    /** Audience check: everyone on an unprotected server; else the user, or anyone holding the permission. */
    private _allows(auth: CliServerAuthContext | undefined, audience: CliEventAudience): boolean {
        if (!this._auth?.protectServer) return true;
        if (!audience.permission && !audience.userId) return true;
        if (!auth) return false;
        if (audience.userId && auth.userId === audience.userId) return true;
        return !!audience.permission && this._auth.hasPermission(auth, audience.permission);
    }

    /**
     * Broadcast a disconnect event to all connected clients and close sockets.
     */
    async broadcastDisconnect(): Promise<void> {
        logger.info('Broadcasting disconnect to %d clients', this._clients.size);
        const message = JSON.stringify({ type: 'disconnect' });

        const promises: Promise<void>[] = [];

        for (const ws of this._clients) {
            if (ws.readyState === WebSocket.OPEN) {
                promises.push(
                    new Promise<void>((resolve) => {
                        ws.send(message, () => {
                            ws.close(1000, 'Server shutting down');
                            resolve();
                        });
                    }),
                );
            }
        }

        await Promise.all(promises);
        this._shellManager.dispose();
        this._sessionBound.dispose();
        this._clients.clear();
        this._clientMeta.clear();
    }

    /**
     * Return information about all currently connected event clients.
     */
    getClients(): CliWebSocketClientInfo[] {
        const result: CliWebSocketClientInfo[] = [];
        for (const ws of this._clients) {
            if (ws.readyState === WebSocket.OPEN) {
                const meta = this._clientMeta.get(ws);
                if (meta) {
                    result.push({
                        id: meta.id,
                        connectedAt: meta.connectedAt.toISOString(),
                        remoteAddress: meta.remoteAddress,
                        type: 'events',
                    });
                }
            }
        }
        return result;
    }

    /** Terminates all connections and closes the WebSocket server. */
    dispose(): void {
        this._shellManager.dispose();
        this._sessionBound.dispose();
        for (const ws of this._clients) {
            ws.terminate();
        }
        this._clients.clear();
        this._clientMeta.clear();
        this._wss?.close();
    }
}
