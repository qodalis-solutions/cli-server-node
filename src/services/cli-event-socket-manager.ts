import { WebSocket, WebSocketServer } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { URL } from 'url';
import { CliShellSessionManager } from './cli-shell-session-manager';
import { createLogger } from '../utils/logger';

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
}

/**
 * Manages WebSocket connections for server-push events and interactive shell sessions.
 * Handles upgrades on `/ws/v1/qcli/events` and `/ws/v1/qcli/shell` paths.
 */
export class CliEventSocketManager {
    private _wss: WebSocketServer | null = null;
    private readonly _clients = new Set<WebSocket>();
    private readonly _clientMeta = new Map<WebSocket, ClientEntry>();
    private readonly _shellManager = new CliShellSessionManager();
    private _nextClientId = 1;

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

        server.on('upgrade', (request, socket, head) => {
            const parsed = new URL(request.url ?? '', 'http://localhost');
            const pathname = parsed.pathname;

            if (CliEventSocketManager.EVENT_PATHS.has(pathname)) {
                this._wss!.handleUpgrade(request, socket, head, (ws) => {
                    this._wss!.emit('connection', ws, request);
                });
                return;
            }

            if (CliEventSocketManager.SHELL_PATHS.has(pathname)) {
                this._wss!.handleUpgrade(request, socket, head, (ws) => {
                    const cols = parseInt(parsed.searchParams.get('cols') ?? '80', 10) || 80;
                    const rows = parseInt(parsed.searchParams.get('rows') ?? '24', 10) || 24;
                    const cmd = parsed.searchParams.get('cmd') || undefined;

                    this._shellManager.handleSession(ws, cols, rows, cmd).catch((err) => {
                        try {
                            ws.send(JSON.stringify({ type: 'error', message: err.message }));
                            ws.close();
                        } catch {
                            // ignore
                        }
                    });
                });
                return;
            }

            // Unrecognized path; leave for other upgrade handlers
        });

        this._wss.on('connection', (ws, request: IncomingMessage) => {
            this._clients.add(ws);
            const id = `evt-${this._nextClientId++}`;
            this._clientMeta.set(ws, {
                id,
                connectedAt: new Date(),
                remoteAddress: request.socket.remoteAddress ?? 'unknown',
            });
            logger.info('Client connected (id=%s)', id);
            ws.send(JSON.stringify({ type: 'connected' }));

            ws.on('close', () => {
                const meta = this._clientMeta.get(ws);
                logger.info('Client disconnected (id=%s)', meta?.id ?? 'unknown');
                this._clients.delete(ws);
                this._clientMeta.delete(ws);
            });

            ws.on('error', () => {
                const meta = this._clientMeta.get(ws);
                logger.info('Client disconnected (id=%s)', meta?.id ?? 'unknown');
                this._clients.delete(ws);
                this._clientMeta.delete(ws);
            });
        });
    }

    /**
     * Broadcast an arbitrary message to all connected event clients.
     */
    broadcastMessage(message: Record<string, unknown>): void {
        const data = JSON.stringify(message);
        for (const ws of this._clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        }
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
        for (const ws of this._clients) {
            ws.terminate();
        }
        this._clients.clear();
        this._clientMeta.clear();
        this._wss?.close();
    }
}
