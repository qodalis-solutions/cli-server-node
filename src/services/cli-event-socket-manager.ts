import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import { URL } from 'url';
import { CliShellSessionManager } from './cli-shell-session-manager';

export class CliEventSocketManager {
    private _wss: WebSocketServer | null = null;
    private readonly _clients = new Set<WebSocket>();
    private readonly _shellManager = new CliShellSessionManager();

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

            // Not our path — let other handlers deal with it
        });

        this._wss.on('connection', (ws) => {
            this._clients.add(ws);
            ws.send(JSON.stringify({ type: 'connected' }));

            ws.on('close', () => {
                this._clients.delete(ws);
            });

            ws.on('error', () => {
                this._clients.delete(ws);
            });
        });
    }

    /**
     * Broadcast a disconnect event to all connected clients and close sockets.
     */
    async broadcastDisconnect(): Promise<void> {
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
    }

    dispose(): void {
        for (const ws of this._clients) {
            ws.terminate();
        }
        this._clients.clear();
        this._wss?.close();
    }
}
