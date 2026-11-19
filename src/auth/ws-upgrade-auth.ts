import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import {
    CliServerAuthContext,
    CliServerAuthError,
    HOST_TOKENS_CANNOT_USE_CLI_ROUTES,
    ICliServerAuth,
    isOriginAllowed,
    isSameOrigin,
} from './cli-server-auth';
import { createLogger } from '../utils/logger';

const logger = createLogger('WsUpgradeAuth');

/** Prefix of the users plugin's API tokens, the only bearers {@link hostTokenRefusal} looks at. */
const API_TOKEN_PREFIX = 'qcli_pat_';

/**
 * Sockets authenticate with tickets, never with a bearer. When an upgrade carries an
 * API token (`Authorization: Bearer qcli_pat_…`) that the auth provider identifies
 * as a host token ({@link ICliServerAuth.isHostTokenBearer}: a token-store lookup
 * only, no host adapter, no `lastUsedAt` write), returns
 * `forbidden: host tokens cannot use CLI routes` so the socket is refused with a 403
 * instead of a 401. Grants nothing: any other outcome returns undefined. The scheme
 * is matched exactly (`Bearer `, case-sensitive), as the users plugin's authenticator
 * reads it: a `bearer …` header is no credential there, so it is not a host token here.
 */
export async function hostTokenRefusal(auth: ICliServerAuth, request: Pick<IncomingMessage, 'headers'>): Promise<string | undefined> {
    const header = request.headers.authorization;
    if (!auth.isHostTokenBearer || typeof header !== 'string' || !header.startsWith(`Bearer ${API_TOKEN_PREFIX}`)) return undefined;
    try {
        return (await auth.isHostTokenBearer(header.slice('Bearer '.length).trim())) ? HOST_TOKENS_CANNOT_USE_CLI_ROUTES : undefined;
    } catch (err) {
        logger.warn('host token check failed: %s', (err as Error)?.message ?? err);
        return undefined;
    }
}

export interface WsUpgradeAuthOptions {
    auth?: ICliServerAuth;
    allowedOrigins?: string[];
    /** Honour `X-Forwarded-Proto`/`X-Forwarded-Host` when deciding whether the Origin is the server's own. */
    trustProxy?: boolean | number;
    /** Permission required on top of authentication (protected mode only). */
    permission?: string;
}

export type WsUpgradeAuthResult =
    | { ok: true; ctx?: CliServerAuthContext }
    | { ok: false; status: 401 | 403 };

/**
 * Authorizes a WebSocket upgrade:
 * - when `allowedOrigins` is set, a present `Origin` header must be allowed or
 *   be the server's own origin (same-origin, e.g. the bundled dashboard) (403);
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
        if (!isOriginAllowed(origin, options.allowedOrigins) && !isSameOrigin(origin, request, options.trustProxy ?? false)) {
            return { ok: false, status: 403 };
        }
    }

    const auth = options.auth;
    if (!auth) {
        return { ok: true };
    }
    const ticket = url.searchParams.get('ticket');
    let hostToken = false;
    const ctx = ticket
        ? await auth.consumeTicket(ticket).catch((err: CliServerAuthError) => {
              hostToken = err?.hostToken === true;
              return undefined;
          })
        : undefined;

    // Sockets take tickets only; a host token presented as a bearer is refused (403), on an
    // unprotected server too
    if (hostToken || (await hostTokenRefusal(auth, request))) {
        return { ok: false, status: 403 };
    }
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
