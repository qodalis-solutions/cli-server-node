import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthService, AuthContext, UsersSessionEvent } from './services/auth-service';
import { RequestAuthenticator, PASSWORD_CHANGE_REQUIRED } from './middleware/auth-middleware';
import { HttpError, forbidden, unauthorized } from './errors';
import { hasPermission } from './permissions';
import { SessionMetadata } from './models';
import { hashToken } from './security';

/** Identity handed to the CLI server (same shape as `CliServerAuthContext` in `@qodalis/cli-server-node`). */
export interface UsersServerAuthContext {
    userId: string;
    userName: string;
    sessionId?: string;
    permissions: string[];
}

const OWN_ROUTES = /^\/api\/v1\/qcli\/(sessions|users|groups|audit)(\/.*)?$/;

/**
 * The users plugin as the CLI server's auth provider (implements
 * `ICliServerAuth` structurally) and as the admin dashboard's auth provider.
 */
export class UsersServerAuth {
    constructor(
        private readonly authService: AuthService,
        private readonly authenticator: RequestAuthenticator,
        readonly protectServer: boolean,
        private readonly onAttach: (server: { allowedOrigins?: string[]; broadcast: (msg: Record<string, unknown>) => void }) => void,
    ) {}

    static toServerContext(ctx: AuthContext): UsersServerAuthContext {
        return {
            userId: ctx.user.id,
            userName: ctx.user.name,
            ...(ctx.session ? { sessionId: ctx.session.id } : {}),
            permissions: [...ctx.permissions],
        };
    }

    /** The plugin authenticates its own routes (login, users, groups, sessions, audit). */
    handlesPath(path: string, _method: string): boolean {
        return OWN_ROUTES.test(path.toLowerCase());
    }

    /** Authenticates a request for a protected server route (403 while a password change is required). */
    async authenticateRequest(req: Request): Promise<UsersServerAuthContext> {
        const ctx = await this.authenticateFull(req);
        return UsersServerAuth.toServerContext(ctx);
    }

    /** Like {@link authenticateRequest} but returns the full context (live user). */
    async authenticateFull(req: Request): Promise<AuthContext> {
        const ctx = await this.authenticator.authenticate(req);
        if (ctx.user.mustChangePassword) {
            throw forbidden(PASSWORD_CHANGE_REQUIRED);
        }
        return ctx;
    }

    async consumeTicket(ticket: string): Promise<UsersServerAuthContext | undefined> {
        const ctx = await this.authService.consumeTicket(ticket);
        return ctx ? UsersServerAuth.toServerContext(ctx) : undefined;
    }

    hasPermission(ctx: { permissions: string[] }, permission: string): boolean {
        return hasPermission(ctx.permissions, permission);
    }

    attachToServer(server: { allowedOrigins?: string[]; broadcast: (msg: Record<string, unknown>) => void }): void {
        this.onAttach(server);
    }

    // ------------------------------------------- long-lived sockets (shell)

    /**
     * Re-validates a socket identity with fresh permissions. Session-backed
     * identities: session alive, user enabled. Identities from the host's auth
     * adapter (no session) are re-authenticated by calling the adapter again with
     * the socket's original upgrade `request`: undefined when it returns nothing,
     * throws, or resolves a different user (adapter users usually are not in the
     * user store, and `isAdmin` must map to the admin group again).
     */
    async revalidate(ctx: UsersServerAuthContext, request?: IncomingMessage): Promise<UsersServerAuthContext | undefined> {
        if (!ctx.sessionId && this.authenticator.hasAdapter) {
            if (!request) return undefined;
            let fresh: AuthContext;
            try {
                // The adapter's contract is an Express request; a raw upgrade request carries the same headers/socket.
                fresh = await this.authenticator.authenticateWithAdapter(request as Request);
            } catch {
                return undefined;
            }
            if (fresh.user.id !== ctx.userId || fresh.user.mustChangePassword) return undefined;
            return UsersServerAuth.toServerContext(fresh);
        }
        const fresh = await this.authService.revalidate(ctx.userId, ctx.sessionId);
        return fresh ? UsersServerAuth.toServerContext(fresh) : undefined;
    }

    /** Slides the session's idle expiry while its shell is in use. */
    async touch(ctx: UsersServerAuthContext): Promise<void> {
        if (ctx.sessionId) await this.authService.touchSession(ctx.sessionId);
    }

    /** Writes a server audit entry (e.g. `shell_opened` / `shell_closed`). */
    async audit(entry: {
        event: string;
        userId: string;
        userName: string;
        actorId?: string;
        actorName?: string;
        details?: string;
        metadata?: Record<string, unknown>;
    }): Promise<void> {
        await this.authService.audit({
            event: entry.event,
            username: entry.userName,
            userId: entry.userId,
            actor: entry.actorName ?? entry.userName,
            actorId: entry.actorId ?? entry.userId,
            details: entry.details,
            metadata: entry.metadata,
        });
    }

    /** Session lifecycle events (logout, expiry, revoke, user/group changes). */
    onSessionEvent(listener: (event: UsersSessionEvent) => void): () => void {
        return this.authService.onSessionEvent(listener);
    }

    // ------------------------------------------------ admin dashboard provider

    /** Logs in through the users plugin (lockout, audit, disabled checks apply). */
    async login(
        username: string,
        password: string,
        metadata: SessionMetadata = {},
    ): Promise<{ token: string; userName: string; permissions: string[]; expiresAt: number; mustChangePassword: boolean }> {
        const result = await this.authService.login(username, password, metadata);
        return {
            token: result.token,
            userName: result.session.user.name,
            permissions: result.session.permissions,
            expiresAt: result.session.expiresAt,
            mustChangePassword: !!result.session.user.mustChangePassword,
        };
    }

    async authenticateToken(token: string): Promise<{ userName: string; permissions: string[]; mustChangePassword: boolean; loginTime: number }> {
        const ctx = await this.authService.authenticateToken(token);
        return {
            userName: ctx.user.name,
            permissions: ctx.permissions,
            mustChangePassword: !!ctx.user.mustChangePassword,
            loginTime: ctx.session?.createdAt ?? Date.now(),
        };
    }

    async logout(token: string): Promise<void> {
        await this.authService.logout(hashToken(token));
    }

    // ------------------------------------------------------ host app guards

    /** Express middleware for host-app routes: requires a users session (sets `req.qcliAuth`). */
    requireAuth(): RequestHandler {
        return this.guard([]);
    }

    /** Express middleware for host-app routes: requires all the given permissions. */
    requirePermission(...permissions: string[]): RequestHandler {
        return this.guard(permissions);
    }

    private guard(permissions: string[]): RequestHandler {
        return (req: Request, res: Response, next: NextFunction) => {
            this.authenticateFull(req).then(
                (ctx) => {
                    const missing = permissions.filter((p) => !hasPermission(ctx.permissions, p));
                    if (missing.length > 0) {
                        res.status(403).json({ error: `forbidden: missing permission ${missing.join(', ')}` });
                        return;
                    }
                    req.qcliAuth = ctx;
                    next();
                },
                (err) => {
                    const status = err instanceof HttpError ? err.status : 401;
                    res.status(status).json({ error: err instanceof HttpError ? err.message : unauthorized().message });
                },
            );
        };
    }
}
