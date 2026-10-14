import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { CliServerAuthContext, ICliServerAuth, isOriginAllowed } from './cli-server-auth';

export interface WsUpgradeAuthOptions {
    auth?: ICliServerAuth;
    allowedOrigins?: string[];
    /** Permission required on top of authentication (protected mode only). */
    permission?: string;
}

export type WsUpgradeAuthResult =
    | { ok: true; ctx?: CliServerAuthContext }
    | { ok: false; status: 401 | 403 };

/**
 * Authorizes a WebSocket upgrade:
 * - when `allowedOrigins` is set, a present `Origin` header must be allowed (403);
 * - with a protecting auth provider, a valid single-use `?ticket=` is required
 *   (401) and the optional permission is checked (403);
 * - otherwise a ticket, when present, only attaches an identity.
 */
export async function authorizeWsUpgrade(
    request: IncomingMessage,
    url: URL,
    options: WsUpgradeAuthOptions,
): Promise<WsUpgradeAuthResult> {
    const origin = request.headers.origin;
    if (options.allowedOrigins && options.allowedOrigins.length > 0 && origin !== undefined) {
        if (!isOriginAllowed(origin, options.allowedOrigins)) {
            return { ok: false, status: 403 };
        }
    }

    const auth = options.auth;
    if (!auth) {
        return { ok: true };
    }
    const ticket = url.searchParams.get('ticket');
    const ctx = ticket ? await auth.consumeTicket(ticket).catch(() => undefined) : undefined;

    if (!auth.protectServer) {
        return { ok: true, ctx };
    }
    if (!ctx) {
        return { ok: false, status: 401 };
    }
    if (options.permission && !auth.hasPermission(ctx, options.permission)) {
        return { ok: false, status: 403 };
    }
    return { ok: true, ctx };
}

/** Rejects an upgrade with a bare HTTP status response. */
export function rejectUpgrade(socket: Duplex, status: number): void {
    const text = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Error';
    try {
        socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
        // ignore
    }
    socket.destroy();
}
