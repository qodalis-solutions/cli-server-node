import { WebSocket } from 'ws';
import { createLogger } from '../utils/logger';
import { CliServerAuthContext, CliServerSessionEvent, ICliServerAuth } from '../auth/cli-server-auth';

const logger = createLogger('SessionBoundSockets');

/** Close code and reason of a socket whose session ended. */
export const SESSION_ENDED_CLOSE_CODE = 4401;
export const SESSION_ENDED_REASON = 'session ended';

/**
 * How long a socket waits for its `session-kicked` event once its session
 * ended by a revocation (or a re-check found it dead) before it is closed anyway.
 */
const KICK_GRACE_MS = 1000;

export interface SessionBoundSocketsOptions {
    /**
     * Sockets that receive `session-kicked` (the events socket): a revocation
     * closes them only after that event was sent ({@link kicked}), or after a
     * short grace period when it never comes.
     */
    awaitKick?: boolean;
}

interface Bound {
    ctx: CliServerAuthContext;
    /** Ended; waiting for `session-kicked` (grace timer). */
    ending?: ReturnType<typeof setTimeout>;
    checking?: boolean;
}

/**
 * Binds authenticated events/logs WebSockets to the stored session behind
 * their ticket: when it ends (logout, revoke, user disabled/deleted, expiry)
 * the socket is closed with 4401 `session ended`. The auth provider's session
 * events drive it: `session-ended` closes the session's sockets, any other
 * event (users/groups changes, the expiry sweep) re-checks every bound socket.
 * Identities without a stored session (external adapter) are not bound.
 */
export class SessionBoundSockets {
    private readonly _bound = new Map<WebSocket, Bound>();
    private _auth?: ICliServerAuth;
    private _unsubscribe?: () => void;

    constructor(private readonly _options: SessionBoundSocketsOptions = {}) {}

    /** Installs the auth provider and subscribes to its session events. */
    setAuth(auth: ICliServerAuth | undefined): void {
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._auth = auth;
        if (auth?.onSessionEvent) {
            this._unsubscribe = auth.onSessionEvent((event) => this.onSessionEvent(event));
        }
    }

    /** Tracks `ws` when `ctx` comes from a stored session or an API token. */
    bind(ws: WebSocket, ctx: CliServerAuthContext | undefined): void {
        if (ctx?.sessionId || ctx?.tokenId) this._bound.set(ws, { ctx });
    }

    unbind(ws: WebSocket): void {
        const entry = this._bound.get(ws);
        if (entry?.ending) clearTimeout(entry.ending);
        this._bound.delete(ws);
    }

    /** True once the socket's session ended (it must not receive server-wide events any more). */
    isEnding(ws: WebSocket): boolean {
        return !!this._bound.get(ws)?.ending;
    }

    /** `session-kicked` was delivered to `ws` for its own session: close it now. */
    kicked(ws: WebSocket): void {
        this.close(ws);
    }

    /** Re-checks every bound socket (optionally only `userId`'s) and closes those whose session ended. */
    async recheck(userId?: string): Promise<void> {
        const auth = this._auth;
        if (!auth?.revalidate) return;
        const checks: Promise<void>[] = [];
        for (const [ws, entry] of this._bound) {
            if (entry.ending || entry.checking || (userId && entry.ctx.userId !== userId)) continue;
            entry.checking = true;
            checks.push(
                (async () => {
                    let alive: boolean;
                    try {
                        alive = !!(await auth.revalidate!(entry.ctx));
                    } catch (err) {
                        logger.warn('Socket session check failed; closing the socket: %s', (err as Error)?.message ?? err);
                        alive = false;
                    }
                    entry.checking = false;
                    if (!alive && this._bound.get(ws) === entry) this.ended(ws, entry, true);
                })(),
            );
        }
        await Promise.all(checks);
    }

    dispose(): void {
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        for (const entry of this._bound.values()) {
            if (entry.ending) clearTimeout(entry.ending);
        }
        this._bound.clear();
    }

    private onSessionEvent(event: CliServerSessionEvent): void {
        if (event.type === 'session-ended') {
            for (const [ws, entry] of [...this._bound]) {
                if (entry.ctx.sessionId === event.sessionId) this.ended(ws, entry, !!event.revoked);
            }
        } else {
            void this.recheck(event.userId);
        }
    }

    /** The session behind `ws` ended; `mayBeKicked`: a `session-kicked` event may still follow. */
    private ended(ws: WebSocket, entry: Bound, mayBeKicked: boolean): void {
        if (!this._options.awaitKick || !mayBeKicked) {
            this.close(ws);
            return;
        }
        if (entry.ending) return;
        entry.ending = setTimeout(() => this.close(ws), KICK_GRACE_MS);
        entry.ending.unref?.();
    }

    private close(ws: WebSocket): void {
        this.unbind(ws);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            try {
                ws.close(SESSION_ENDED_CLOSE_CODE, SESSION_ENDED_REASON);
            } catch {
                ws.terminate();
            }
        }
    }
}
