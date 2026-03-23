import { WebSocket, WebSocketServer } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { URL } from 'url';

/** Information about a connected WebSocket log-streaming client. */
export interface CliLogWebSocketClientInfo {
    id: string;
    connectedAt: string;
    remoteAddress: string;
    levelFilter: string | null;
    type: 'logs';
}

interface LogClientEntry {
    id: string;
    ws: WebSocket;
    connectedAt: Date;
    remoteAddress: string;
    levelFilter: string | null;
}

/**
 * Level ordering from lowest to highest severity.
 * Matches the Python/C# implementations.
 */
const LEVEL_ORDER: Record<string, number> = {
    verbose: 0,
    debug: 1,
    information: 2,
    warning: 3,
    error: 4,
    fatal: 5,
};

/**
 * Maps short/uppercase log levels (used by LogRingBuffer) to the
 * standard level names used across all three servers.
 */
const LEVEL_ALIASES: Record<string, string> = {
    info: 'information',
    warn: 'warning',
    err: 'error',
};

function normalizeLevel(level: string): string {
    const lower = level.toLowerCase();
    return LEVEL_ALIASES[lower] ?? lower;
}

/**
 * Manages WebSocket connections for streaming log messages to clients.
 *
 * Parity with CliLogSocketManager in the .NET and Python servers.
 * Handles `/ws/v1/qcli/logs` and `/ws/qcli/logs` upgrade paths.
 */
export class CliLogSocketManager {
    private _wss: WebSocketServer | null = null;
    private readonly _clients = new Map<string, LogClientEntry>();
    private _nextClientId = 1;

    private static readonly LOG_PATHS = new Set([
        '/ws/v1/qcli/logs',
        '/ws/qcli/logs',
    ]);

    /**
     * Check whether a log at `logLevel` passes the `filterLevel` gate.
     */
    static shouldSendLog(filterLevel: string | null, logLevel: string): boolean {
        if (!filterLevel) return true;

        const filterOrd = LEVEL_ORDER[normalizeLevel(filterLevel)];
        const logOrd = LEVEL_ORDER[normalizeLevel(logLevel)];

        // Unknown levels always pass
        if (filterOrd === undefined || logOrd === undefined) return true;

        return logOrd >= filterOrd;
    }

    /**
     * Format a log message as a JSON string matching the cross-server schema.
     */
    static formatLogMessage(level: string, message: string, category?: string | null): string {
        return JSON.stringify({
            type: 'log',
            timestamp: new Date().toISOString(),
            level: normalizeLevel(level),
            message,
            category: category ?? null,
        });
    }

    /**
     * Attach to an HTTP server and handle WebSocket upgrades on log paths.
     *
     * If you already have a `CliEventSocketManager` attached, call this
     * method on the same `server` — Node's `upgrade` event supports
     * multiple listeners, and each manager only handles its own paths.
     */
    attach(server: Server): void {
        this._wss = new WebSocketServer({ noServer: true });

        server.on('upgrade', (request, socket, head) => {
            const parsed = new URL(request.url ?? '', 'http://localhost');
            const pathname = parsed.pathname;

            if (!CliLogSocketManager.LOG_PATHS.has(pathname)) return;

            this._wss!.handleUpgrade(request, socket, head, (ws) => {
                const levelFilter = parsed.searchParams.get('level') || null;
                this._handleConnection(ws, request, levelFilter);
            });
        });
    }

    /**
     * Broadcast a log message to all connected clients whose filter allows it.
     */
    broadcastLog(level: string, message: string, category?: string | null): void {
        if (this._clients.size === 0) return;

        let formatted: string | null = null;

        for (const entry of this._clients.values()) {
            if (entry.ws.readyState !== WebSocket.OPEN) continue;
            if (!CliLogSocketManager.shouldSendLog(entry.levelFilter, level)) continue;

            // Lazy-format only when there's at least one recipient
            if (!formatted) {
                formatted = CliLogSocketManager.formatLogMessage(level, message, category);
            }

            try {
                entry.ws.send(formatted);
            } catch {
                // ignore send errors; cleanup happens on close/error events
            }
        }
    }

    /**
     * Send a disconnect message to all clients and close connections.
     */
    async broadcastDisconnect(): Promise<void> {
        const disconnectMsg = JSON.stringify({ type: 'disconnect' });
        const promises: Promise<void>[] = [];

        for (const entry of this._clients.values()) {
            if (entry.ws.readyState === WebSocket.OPEN) {
                promises.push(
                    new Promise<void>((resolve) => {
                        entry.ws.send(disconnectMsg, () => {
                            entry.ws.close(1000, 'Server shutting down');
                            resolve();
                        });
                    }),
                );
            }
        }

        await Promise.all(promises);
        this._clients.clear();
    }

    /**
     * Return information about all currently connected log clients.
     */
    getClients(): CliLogWebSocketClientInfo[] {
        const result: CliLogWebSocketClientInfo[] = [];
        for (const entry of this._clients.values()) {
            if (entry.ws.readyState === WebSocket.OPEN) {
                result.push({
                    id: entry.id,
                    connectedAt: entry.connectedAt.toISOString(),
                    remoteAddress: entry.remoteAddress,
                    levelFilter: entry.levelFilter,
                    type: 'logs',
                });
            }
        }
        return result;
    }

    /** Terminates all connections and closes the WebSocket server. */
    dispose(): void {
        for (const entry of this._clients.values()) {
            entry.ws.terminate();
        }
        this._clients.clear();
        this._wss?.close();
    }

    private _handleConnection(ws: WebSocket, request: IncomingMessage, levelFilter: string | null): void {
        const id = `log-${this._nextClientId++}`;
        const entry: LogClientEntry = {
            id,
            ws,
            connectedAt: new Date(),
            remoteAddress: request.socket.remoteAddress ?? 'unknown',
            levelFilter,
        };

        this._clients.set(id, entry);

        ws.send(JSON.stringify({ type: 'connected' }));

        ws.on('close', () => {
            this._clients.delete(id);
        });

        ws.on('error', () => {
            this._clients.delete(id);
        });
    }
}
