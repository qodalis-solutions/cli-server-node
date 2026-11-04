import type { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { createLogger } from '../utils/logger';
import { CliServerAuthContext, CliServerSessionEvent, ICliServerAuth } from '../auth/cli-server-auth';
import { effectiveSessionCheckIntervalMs } from './cli-shell-options';

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
    /**
     * Permission an identity without a stored session (external auth adapter)
     * must still hold at each re-check (`logs:read` for the logs socket).
     */
    externalPermission?: string;
    /**
     * How often sockets of identities without a stored session are re-checked
     * (the shell's `sessionCheckIntervalMs`: default 30 s, at most 60 s).
     */
    sessionCheckIntervalMs?: number;
}

interface Bound {
    ctx: CliServerAuthContext;
    /** The socket's upgrade request (identities re-authenticated from a request). */
    request?: IncomingMessage;
    /** No stored session or API token: re-authenticated by the auth provider (external adapter). */
    external: boolean;
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
 * Identities without a stored session or token (external auth adapter) are
 * re-authenticated through the provider's `revalidate` (which runs the adapter
 * again on the request the identity came from) every `sessionCheckIntervalMs`
 * and on those events; they close when it fails or, with `externalPermission`,
 * when the identity no longer holds that permission. Checks never stack: a
 * socket whose check is still running is skipped.
 */
export class SessionBoundSockets {
    private readonly _bound = new Map<WebSocket, Bound>();
    private _auth?: ICliServerAuth;
    private _unsubscribe?: () => void;
    private _externalTimer?: ReturnType<typeof setInterval>;

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

    /**
     * Tracks `ws` when `ctx` comes from a stored session or an API token, or —
     * when the provider can re-validate it — from an external auth adapter.
     * `request` is the socket's upgrade request.
     */
    bind(ws: WebSocket, ctx: CliServerAuthContext | undefined, request?: IncomingMessage): void {
        if (!ctx) return;
        if (ctx.sessionId || ctx.tokenId) {
            this._bound.set(ws, { ctx, request, external: false });
        } else if (this._auth?.revalidate) {
            this._bound.set(ws, { ctx, request, external: true });
            this.ensureExternalTimer();
        }
    }

    unbind(ws: WebSocket): void {
        const entry = this._bound.get(ws);
        if (entry?.ending) clearTimeout(entry.ending);
        this._bound.delete(ws);
        this.stopExternalTimerIfIdle();
    }

    /** True once the socket's session ended (it must not receive server-wide events any more). */
    isEnding(ws: WebSocket): boolean {
        return !!this._bound.get(ws)?.ending;
    }

    /** `session-kicked` was delivered to `ws` for its own session: close it now. */
    kicked(ws: WebSocket): void {
        this.close(ws);
    }

    /**
     * Re-checks every bound socket (optionally only `userId`'s, or only the
     * external-adapter ones) and closes those whose session ended.
     */
    async recheck(userId?: string, externalOnly = false): Promise<void> {
        const auth = this._auth;
        if (!auth?.revalidate) return;
        const permission = this._options.externalPermission;
        const checks: Promise<void>[] = [];
        for (const [ws, entry] of this._bound) {
            if (entry.ending || entry.checking || (userId && entry.ctx.userId !== userId)) continue;
            if (externalOnly && !entry.external) continue;
            entry.checking = true;
            checks.push(
                (async () => {
                    let alive: boolean;
                    try {
                        const fresh = await auth.revalidate!(entry.ctx, entry.request);
                        alive = !!fresh && (!entry.external || !permission || auth.hasPermission(fresh, permission));
                        if (fresh && alive && entry.external) entry.ctx = { ...entry.ctx, permissions: fresh.permissions };
                    } catch (err) {
                        logger.warn('Socket session check failed; closing the socket: %s', (err as Error)?.message ?? err);
                        alive = false;
                    }
                    entry.checking = false;
                    if (!alive && this._bound.get(ws) === entry) this.ended(ws, entry, !entry.external);
                })(),
            );
        }
        await Promise.all(checks);
    }

    dispose(): void {
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        if (this._externalTimer) clearInterval(this._externalTimer);
        this._externalTimer = undefined;
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

    /** Re-checks external-adapter sockets every `sessionCheckIntervalMs` while any is bound. */
    private ensureExternalTimer(): void {
        if (this._externalTimer) return;
        const interval = effectiveSessionCheckIntervalMs(this._options.sessionCheckIntervalMs);
        this._externalTimer = setInterval(() => void this.recheck(undefined, true), interval);
        this._externalTimer.unref?.();
    }

    private stopExternalTimerIfIdle(): void {
        if (this._externalTimer && ![...this._bound.values()].some((e) => e.external)) {
            clearInterval(this._externalTimer);
            this._externalTimer = undefined;
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
