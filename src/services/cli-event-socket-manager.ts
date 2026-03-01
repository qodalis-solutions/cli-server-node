import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';

export class CliEventSocketManager {
    private _wss: WebSocketServer | null = null;
    private readonly _clients = new Set<WebSocket>();

    private static readonly ALLOWED_WS_PATHS = new Set([
        '/ws/cli/events',
        '/ws/v1/cli/events',
        '/ws/v2/cli/events',
    ]);

    /**
     * Attach to an HTTP server and listen for WebSocket upgrades on
     * /ws/cli/events, /ws/v1/cli/events, and /ws/v2/cli/events.
     */
    attach(server: Server): void {
        this._wss = new WebSocketServer({ noServer: true });

        server.on('upgrade', (request, socket, head) => {
            if (!CliEventSocketManager.ALLOWED_WS_PATHS.has(request.url ?? '')) {
                return; // Let other upgrade handlers (if any) handle it
            }

            this._wss!.handleUpgrade(request, socket, head, (ws) => {
                this._wss!.emit('connection', ws, request);
            });
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
