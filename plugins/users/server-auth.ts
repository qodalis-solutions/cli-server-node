import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
    AuthService,
    AuthContext,
    HOST_TOKEN_REQUIRED,
    hostTokenRefused,
    UsersSessionEvent,
    isApiToken,
    isHostToken,
    tokenAudience,
} from './services/auth-service';
import { RequestAuthenticator, PASSWORD_CHANGE_REQUIRED } from './middleware/auth-middleware';
import { forbidden, unauthorized } from './errors';
import { hasPermission } from './permissions';
import { QcliCaller, SessionMetadata, UsersPermissionCatalog } from './models';
import { hashToken } from './security';

/**
 * Symbol-keyed slot on an adapter identity holding the request the adapter
 * accepted (e.g. `POST /sessions/ws-ticket`). Symbol keys survive object spread
 * (the server copies contexts) and are skipped by `JSON.stringify`.
 */
export const EXTERNAL_REQUEST: unique symbol = Symbol('qcli.users.externalRequest');

/** Identity handed to the CLI server (same shape as `CliServerAuthContext` in `@qodalis/cli-server-node`). */
export interface UsersServerAuthContext {
    userId: string;
    userName: string;
    sessionId?: string;
    /** Set when the identity comes from an API token (no session). */
    tokenId?: string;
    permissions: string[];
    /** Adapter identities: the request the adapter accepted (see {@link EXTERNAL_REQUEST}). */
    [EXTERNAL_REQUEST]?: Request | IncomingMessage;
}

/** The server the provider is installed into (`ICliServerAuth.attachToServer`). */
export interface UsersServerAttachment {
    allowedOrigins?: string[];
    broadcast: (msg: Record<string, unknown>) => void;
    /** The server's event bus (structurally `ICliEventBus`). */
    eventBus?: import('@qodalis/cli-server-abstractions').ICliEventBus;
    /** The server's runtime options (`externalAuthentication` is set from the auth adapter). */
    serverOptions?: { externalAuthentication: boolean };
    /** The server's permission catalog (structurally core's `CliPermissionCatalog`). */
    permissions?: UsersPermissionCatalog;
    /** False when the server serves no CLI routes; a guard-only plugin needs exactly that. */
    cliRoutes?: boolean;
}

/**
 * Request slot (shared by key, no import needed) where a guard that already counted the
 * request (the public-api plugin) leaves a function taking that count back. Any later guard
 * that refuses the request runs it before answering, so a refused request is not counted.
 */
export const ON_REFUSED: unique symbol = Symbol.for('qcli.onRefused') as never;

/** Guard-only mode on a server with CLI routes (or on none): fails closed. */
export const GUARD_ONLY_NEEDS_NO_CLI_ROUTES = 'guard-only needs cliRoutes: false';

const OWN_ROUTES = /^\/api\/v1\/qcli\/(sessions|users|groups|tokens|link|permissions)(\/.*)?$/;

/**
 * The users plugin as the CLI server's auth provider (implements
 * `ICliServerAuth` structurally) and as the admin dashboard's auth provider.
 */
export class UsersServerAuth {
    constructor(
        private readonly authService: AuthService,
        private readonly authenticator: RequestAuthenticator,
        readonly protectServer: boolean,
        private readonly onAttach: (server: UsersServerAttachment) => void,
        /** Guard-only mode: accepted only by a server without CLI routes (`cliRoutes: false`). */
        readonly guardOnly = false,
    ) {
        this.serverReady = !guardOnly;
    }

    /**
     * Guard-only: true once a server without CLI routes attached the plugin. Until then the
     * guards answer 500, so a host that never mounts the plugin (or mounts it on a server
     * with CLI routes) cannot leave the CLI open while its own routes seem guarded.
     */
    private serverReady: boolean;
    private notReadyLogged = false;

    static toServerContext(ctx: AuthContext): UsersServerAuthContext {
        return {
            userId: ctx.user.id,
            userName: ctx.user.name,
            ...(ctx.session ? { sessionId: ctx.session.id } : {}),
            ...(ctx.apiToken ? { tokenId: ctx.apiToken.id } : {}),
            permissions: [...ctx.permissions],
            ...(ctx.externalRequest ? { [EXTERNAL_REQUEST]: ctx.externalRequest } : {}),
        };
    }

    /**
     * The plugin authenticates its own routes (login, users, groups, sessions, tokens). The
     * audit API it serves is protected by the server's route policy (`audit:read` / `audit:clear`).
     */
    handlesPath(path: string, _method: string): boolean {
        return OWN_ROUTES.test(path.toLowerCase());
    }

    /**
     * Authenticates a request for a protected server route: 403 for a `host` token
     * (CLI routes never accept one), then 403 while a password change is required.
     */
    async authenticateRequest(req: Request): Promise<UsersServerAuthContext> {
        const ctx = await this.authenticator.authenticate(req);
        if (isHostToken(ctx)) {
            throw hostTokenRefused();
        }
        return UsersServerAuth.toServerContext(this.requireNoPasswordChange(ctx));
    }

    /**
     * Authenticates a request for a host route (the guards): the full context (live
     * user), `host` tokens included; 403 while a password change is required.
     */
    async authenticateFull(req: Request): Promise<AuthContext> {
        return this.requireNoPasswordChange(await this.authenticator.authenticate(req));
    }

    private requireNoPasswordChange(ctx: AuthContext): AuthContext {
        if (ctx.user.mustChangePassword) {
            throw forbidden(PASSWORD_CHANGE_REQUIRED);
        }
        return ctx;
    }

    async consumeTicket(ticket: string): Promise<UsersServerAuthContext | undefined> {
        const ctx = await this.authService.consumeTicket(ticket);
        // Tickets come from `POST /sessions/ws-ticket`, which refuses host tokens; never open a socket for one
        if (ctx && isHostToken(ctx)) throw hostTokenRefused();
        return ctx ? UsersServerAuth.toServerContext(ctx) : undefined;
    }

    /**
     * True when `token` is a stored, unexpired `host` API token. Only reads the token
     * store: no auth adapter call, no `lastUsedAt` write, no user lookup. Always false
     * when an auth adapter signs users in without API tokens (`apiTokensWithExternalAuth`
     * off), since the plugin's tokens are not accepted there at all.
     */
    async isHostTokenBearer(token: string): Promise<boolean> {
        if (typeof token !== 'string' || !isApiToken(token)) return false;
        if (this.authenticator.hasAdapter && !this.authService.apiTokensWithExternalAuth) return false;
        const stored = await this.authService.apiTokenStore.getTokenByHash(hashToken(token));
        return !!stored && tokenAudience(stored) === 'host' && !AuthService.isTokenExpired(stored);
    }

    hasPermission(ctx: { permissions: string[] }, permission: string): boolean {
        return hasPermission(ctx.permissions, permission);
    }

    attachToServer(server: UsersServerAttachment): void {
        if (this.guardOnly) {
            if (server.cliRoutes !== false) {
                throw new Error(GUARD_ONLY_NEEDS_NO_CLI_ROUTES);
            }
            this.serverReady = true;
        }
        this.onAttach(server);
    }

    // ------------------------------------------- long-lived sockets (shell)

    /**
     * Re-validates a socket identity with fresh permissions. Session-backed
     * identities: session alive, user enabled. Identities from the host's auth
     * adapter (no session) are re-authenticated by calling the adapter (sync or
     * async) again on the request it accepted — the `POST /sessions/ws-ticket`
     * request for sockets opened with a ticket — or else on the socket's upgrade
     * `request`: undefined when it returns nothing, a disabled or different user,
     * or throws (adapter users usually are not in the user store, and `isAdmin`
     * must map to the admin group again).
     */
    async revalidate(ctx: UsersServerAuthContext, request?: IncomingMessage): Promise<UsersServerAuthContext | undefined> {
        if (ctx.tokenId) {
            const fresh = await this.authService.revalidate(ctx.userId, undefined, ctx.tokenId);
            return fresh && !isHostToken(fresh) ? UsersServerAuth.toServerContext(fresh) : undefined;
        }
        if (!ctx.sessionId && this.authenticator.hasAdapter) {
            const source = ctx[EXTERNAL_REQUEST] ?? request;
            if (!source) return undefined;
            let fresh: AuthContext;
            try {
                // The adapter's contract is an Express request; a raw upgrade request carries the same headers/socket.
                fresh = await this.authenticator.authenticateWithAdapter(source as Request);
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
        if (isHostToken(ctx)) {
            throw hostTokenRefused();
        }
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

    /**
     * Express middleware for host-app routes: requires a users session or API token (sets
     * `req.qcliAuth` and `req.qcliCaller`). Auth errors keep their status (401/403);
     * unexpected errors are logged and answered with 500 `{ error: 'internal server error' }`.
     */
    requireAuth(): RequestHandler {
        return this.guard([], false);
    }

    /** Express middleware for host-app routes: requires all the given permissions (403 otherwise; errors as {@link requireAuth}). */
    requirePermission(...permissions: string[]): RequestHandler {
        return this.guard(permissions, false);
    }

    /**
     * Express middleware for host-app routes that only `host` tokens may call: a session,
     * an adapter sign-in or a `cli` token gets 403 `forbidden: a host token is required`
     * (checked before the permissions); then as {@link requirePermission}.
     */
    requireHostToken(...permissions: string[]): RequestHandler {
        return this.guard(permissions, true);
    }

    private guard(permissions: string[], hostTokenOnly: boolean): RequestHandler {
        return (req: Request, res: Response, next: NextFunction) => {
            // A refused request carries no caller (an earlier guard may have set one) and is not
            // counted (an earlier public-api guard may have counted it: its take-back runs first)
            const refuse = (status: number, error: string) => {
                const slot = req as Request & { [ON_REFUSED]?: () => Promise<void> };
                const takeBack = slot[ON_REFUSED];
                delete slot[ON_REFUSED];
                delete req.qcliCaller;
                delete req.qcliAuth;
                const answer = () => {
                    if (!res.headersSent) res.status(status).json({ error });
                };
                if (takeBack) takeBack().catch(() => undefined).finally(answer);
                else answer();
            };
            if (!this.serverReady) {
                if (!this.notReadyLogged) {
                    this.notReadyLogged = true;
                    console.error(`[users] ${GUARD_ONLY_NEEDS_NO_CLI_ROUTES}: mount the plugin on createCliServer({ cliRoutes: false })`);
                }
                refuse(500, 'internal server error');
                return;
            }
            this.authenticateFull(req).then(
                (ctx) => {
                    if (hostTokenOnly && !isHostToken(ctx)) {
                        refuse(403, HOST_TOKEN_REQUIRED);
                        return;
                    }
                    const missing = permissions.filter((p) => !hasPermission(ctx.permissions, p));
                    if (missing.length > 0) {
                        refuse(403, `forbidden: missing permission ${missing.join(', ')}`);
                        return;
                    }
                    req.qcliAuth = ctx;
                    req.qcliCaller = toQcliCaller(ctx);
                    next();
                },
                (err: { status?: number; message?: string }) => {
                    if (typeof err?.status !== 'number') {
                        // not an auth error (e.g. a store or adapter failure): log it, never expose its message
                        console.error('[users] authentication failed unexpectedly:', err);
                        refuse(500, 'internal server error');
                        return;
                    }
                    const fallback = err.status === 401 ? unauthorized().message : forbidden().message;
                    refuse(err.status, err.message || fallback);
                },
            );
        };
    }
}

/** The caller of a guarded host route, from an authenticated context. */
export function toQcliCaller(ctx: AuthContext): QcliCaller {
    return {
        userId: ctx.user.id,
        userName: ctx.user.name,
        tokenId: ctx.apiToken?.id ?? null,
        audience: ctx.apiToken ? tokenAudience(ctx.apiToken) : null,
        permissions: [...ctx.permissions],
    };
}
