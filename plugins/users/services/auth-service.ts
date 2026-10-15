import { randomBytes, randomUUID } from 'crypto';
import {
    ICliUserStore,
    ICliSessionStore,
    ICliCredentialStore,
    ICliAuditStore,
    ICliGroupStore,
    ICliApiTokenStore,
} from '../stores/interfaces';
import { InMemoryApiTokenStore } from '../stores/in-memory-api-token-store';
import {
    ApiToken,
    ApiTokenView,
    AuditEntry,
    LoginResult,
    Session,
    SessionMetadata,
    SessionPayload,
    SessionView,
    User,
    UsersBroadcastFn,
} from '../models';
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { hashPassword, verifyPasswordHash, dummyVerify } from './password-hasher';
import { hasPermission, mergePermissions } from '../permissions';
import { hashToken, sanitize } from '../security';
import { validatePermissions } from './permission-validation';

export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
export const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000;
export const DEFAULT_MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;
export const DEFAULT_MAX_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
export const WS_TICKET_TTL_SECONDS = 30;

export const LOCKED_MESSAGE = 'account locked, try again later';

/** Prefix of API tokens (`qcli_pat_` + 32 random bytes, base64url without padding). */
export const API_TOKEN_PREFIX = 'qcli_pat_';
export const MAX_API_TOKENS_PER_USER = 20;
export const DEFAULT_API_TOKEN_EXPIRY_DAYS = 90;
export const MAX_API_TOKEN_EXPIRY_DAYS = 365;
/** `lastUsedAt` is written at most once per this interval. */
export const API_TOKEN_LAST_USED_INTERVAL_MS = 60_000;
const API_TOKEN_NAME_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True when the bearer token is an API token (routed to the token store, not the session store). */
export function isApiToken(token: string): boolean {
    return token.startsWith(API_TOKEN_PREFIX);
}

export interface AuthServiceOptions {
    /** Used to compute effective permissions. Without it users have no permissions. */
    groupStore?: ICliGroupStore;
    sessionTimeoutMs?: number;
    maxLoginAttempts?: number;
    lockoutMs?: number;
    minPasswordLength?: number;
    maxSessionLifetimeMs?: number;
    /** Broadcasts `session-kicked` events over the events socket. */
    broadcast?: UsersBroadcastFn;
    /** API token storage (default in-memory). */
    apiTokenStore?: ICliApiTokenStore;
    /** Allow API tokens that never expire (default false). */
    allowNonExpiringTokens?: boolean;
}

/** An authenticated request context: the live user plus, for token auth, the session. */
export interface AuthContext {
    user: User;
    permissions: string[];
    /** Absent for external-auth (adapter) requests. */
    session?: Session;
    /** SHA-256 of the bearer token, for session-token-authenticated requests. */
    tokenHash?: string;
    /** The API token, for requests authenticated by an API token (no session). */
    apiToken?: ApiToken;
}

/**
 * Session lifecycle events (consumed by the CLI server to bind open shells to
 * their session): `session-ended` on logout, expiry, revoke, user disabled or
 * deleted (`revoked` for revocations, which also broadcast `session-kicked`);
 * `access-changed` when users, groups or permissions change, and after each
 * expired-session sweep.
 */
export type UsersSessionEvent =
    | { type: 'session-ended'; sessionId: string; userId?: string; reason?: string; revoked?: boolean }
    | { type: 'access-changed'; userId?: string };

/** Audit events that can change someone's effective permissions or account state. */
const ACCESS_CHANGING_EVENT = /^(user_|group_|password_)/;
/** Group-wide changes: they affect every member, not the acting user the entry is logged for. */
const GROUP_WIDE_EVENT = /^group_(created|updated|deleted)$/;

interface LockoutState {
    /** Failed + in-flight attempts (reserved before verification). */
    failures: number;
    lockedUntil: number;
    /** Time of the latest attempt; an unlocked count older than the lockout window expires. */
    lastAttempt: number;
}

/** Lockout map size above which a new entry first sweeps expired ones. */
const LOCKOUT_SWEEP_THRESHOLD = 1000;

interface TicketEntry {
    expiresAt: number;
    userId: string;
    sessionId?: string;
    /** Identity from an API token (no session). */
    apiTokenId?: string;
    /** External-auth (adapter) requests have no stored session: keep the resolved context. */
    adapterContext?: AuthContext;
}

/**
 * Authentication, credentials, sessions and lockout. Sessions reference users
 * by id; the live user is resolved on every request.
 */
export class AuthService {
    readonly sessionTimeoutMs: number;
    readonly maxLoginAttempts: number;
    readonly lockoutMs: number;
    readonly minPasswordLength: number;
    readonly maxSessionLifetimeMs: number;
    readonly allowNonExpiringTokens: boolean;
    readonly apiTokenStore: ICliApiTokenStore;
    private readonly groupStore?: ICliGroupStore;
    private broadcast?: UsersBroadcastFn;
    private readonly lockouts = new Map<string, LockoutState>();
    private readonly tickets = new Map<string, TicketEntry>();
    private readonly sessionListeners = new Set<(event: UsersSessionEvent) => void>();

    constructor(
        private readonly userStore: ICliUserStore,
        private readonly sessionStore: ICliSessionStore,
        private readonly credentialStore: ICliCredentialStore,
        private readonly auditStore: ICliAuditStore,
        options: AuthServiceOptions = {},
    ) {
        this.groupStore = options.groupStore;
        this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
        this.maxLoginAttempts = options.maxLoginAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS;
        this.lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS;
        this.minPasswordLength = options.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH;
        this.maxSessionLifetimeMs = options.maxSessionLifetimeMs ?? DEFAULT_MAX_SESSION_LIFETIME_MS;
        this.broadcast = options.broadcast;
        this.apiTokenStore = options.apiTokenStore ?? new InMemoryApiTokenStore();
        this.allowNonExpiringTokens = options.allowNonExpiringTokens ?? false;
    }

    setBroadcast(fn: UsersBroadcastFn | undefined): void {
        this.broadcast = fn;
    }

    hasBroadcast(): boolean {
        return !!this.broadcast;
    }

    /** Subscribes to session lifecycle events; returns an unsubscribe function. */
    onSessionEvent(listener: (event: UsersSessionEvent) => void): () => void {
        this.sessionListeners.add(listener);
        return () => this.sessionListeners.delete(listener);
    }

    private emitSessionEvent(event: UsersSessionEvent): void {
        for (const listener of [...this.sessionListeners]) {
            try {
                listener(event);
            } catch (err) {
                console.error('[users] session event listener failed:', err);
            }
        }
    }

    generateToken(): string {
        return randomBytes(32).toString('hex');
    }

    // ---------------------------------------------------------------- audit

    /** Logs an audit entry; string fields are stripped of control characters. */
    async audit(entry: Omit<AuditEntry, 'timestamp'> & { timestamp?: number }): Promise<void> {
        const clean: AuditEntry = {
            timestamp: entry.timestamp ?? Date.now(),
            event: entry.event,
            username: sanitize(entry.username ?? ''),
        };
        if (entry.id !== undefined) clean.id = entry.id;
        if (entry.userId !== undefined) clean.userId = entry.userId;
        if (entry.details !== undefined) clean.details = sanitize(entry.details, 1024);
        if (entry.actor !== undefined) clean.actor = sanitize(entry.actor);
        if (entry.actorId !== undefined) clean.actorId = entry.actorId;
        if (entry.metadata !== undefined) {
            const metadata = Object.fromEntries(Object.entries(entry.metadata).filter(([, v]) => v !== undefined));
            if (Object.keys(metadata).length > 0) clean.metadata = metadata;
        }
        await this.auditStore.log(clean);
        if (ACCESS_CHANGING_EVENT.test(clean.event)) {
            this.emitSessionEvent({ type: 'access-changed', userId: GROUP_WIDE_EVENT.test(clean.event) ? undefined : clean.userId });
        }
    }

    // ---------------------------------------------------------- credentials

    /** Throws 400 when the password does not satisfy the policy. */
    validatePassword(password: unknown): asserts password is string {
        if (typeof password !== 'string' || password.length === 0) {
            throw badRequest('password is required');
        }
        if (password.length < this.minPasswordLength) {
            throw badRequest(`password must be at least ${this.minPasswordLength} characters`);
        }
        if (password.length > MAX_PASSWORD_LENGTH) {
            throw badRequest(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
        }
    }

    async setPassword(userId: string, password: string): Promise<void> {
        const { hash, salt } = await hashPassword(password);
        await this.credentialStore.setPassword(userId, hash, salt);
    }

    async verifyPassword(userId: string, password: string): Promise<boolean> {
        const creds = await this.credentialStore.getCredentials(userId);
        if (!creds || typeof password !== 'string') {
            return false;
        }
        return verifyPasswordHash(password, creds.passwordHash, creds.salt);
    }

    async deleteCredentials(userId: string): Promise<void> {
        await this.credentialStore.deleteCredentials(userId);
        this.clearLockout(userId);
    }

    // -------------------------------------------------------------- lockout

    private static userKey(userId: string): string {
        return `id:${userId}`;
    }

    private static nameKey(name: string): string {
        return `name:${name.toLowerCase()}`;
    }

    isLocked(userId: string): boolean {
        return this.isKeyLocked(AuthService.userKey(userId));
    }

    private isKeyLocked(key: string): boolean {
        const state = this.lockouts.get(key);
        if (!state) return false;
        if (this.isLockoutExpired(state, Date.now())) {
            this.lockouts.delete(key);
            return false;
        }
        return state.lockedUntil !== 0;
    }

    /**
     * A lock is over once `lockedUntil` passed; an unlocked failure count expires
     * once its latest attempt is older than the lockout window (failures only add
     * up while each one follows the previous within the window).
     */
    private isLockoutExpired(state: LockoutState, now: number): boolean {
        return state.lockedUntil !== 0 ? now >= state.lockedUntil : now - state.lastAttempt >= this.lockoutMs;
    }

    /** Drops expired lockout entries (run periodically and when the map grows large). */
    sweepLockouts(): void {
        const now = Date.now();
        for (const [key, state] of this.lockouts) {
            if (this.isLockoutExpired(state, now)) this.lockouts.delete(key);
        }
    }

    /** Clears the lockout of a user (admin password reset, deletion). */
    clearLockout(userId: string): void {
        this.lockouts.delete(AuthService.userKey(userId));
    }

    /**
     * Synchronously reserves an attempt before the (slow) PBKDF2 check, so
     * concurrent requests can never exceed `maxLoginAttempts`. Throws 429 when
     * the key is locked or every remaining attempt is already in flight.
     */
    private reserveAttempt(key: string): void {
        const now = Date.now();
        let state = this.lockouts.get(key);
        if (state && this.isLockoutExpired(state, now)) {
            this.lockouts.delete(key);
            state = undefined;
        }
        if (!state) {
            if (this.lockouts.size >= LOCKOUT_SWEEP_THRESHOLD) this.sweepLockouts();
            state = { failures: 0, lockedUntil: 0, lastAttempt: now };
            this.lockouts.set(key, state);
        }
        if (state.lockedUntil > now || state.failures >= this.maxLoginAttempts) {
            throw new HttpError(429, LOCKED_MESSAGE);
        }
        state.failures += 1;
        state.lastAttempt = now;
    }

    private attemptFailed(key: string): void {
        const now = Date.now();
        const state = this.lockouts.get(key) ?? { failures: 1, lockedUntil: 0, lastAttempt: now };
        state.lastAttempt = now;
        if (state.failures >= this.maxLoginAttempts && state.lockedUntil === 0) {
            state.lockedUntil = now + this.lockoutMs;
        }
        this.lockouts.set(key, state);
    }

    private attemptSucceeded(key: string): void {
        this.lockouts.delete(key);
    }

    /**
     * Verifies a password with lockout: reserves the attempt first (429 while
     * locked), resets on success, audits `login_failed` on mismatch. Unknown
     * users (`user` undefined) are tracked by the attempted name and run a
     * dummy PBKDF2 so timing does not reveal whether the account exists.
     */
    async verifyPasswordWithLockout(
        user: User | undefined,
        password: string,
        context: { attemptedName?: string; actor?: string; actorId?: string; remoteAddress?: string; details?: string } = {},
    ): Promise<boolean> {
        const attempted = sanitize(context.attemptedName ?? user?.name ?? '', 64);
        const key = user ? AuthService.userKey(user.id) : AuthService.nameKey(attempted);
        try {
            this.reserveAttempt(key);
        } catch (err) {
            await this.audit({
                event: 'login_failed',
                username: user?.name ?? attempted,
                userId: user?.id,
                actor: context.actor,
                actorId: context.actorId,
                details: 'Account locked',
                metadata: { remoteAddress: context.remoteAddress },
            });
            throw err;
        }

        const valid = user ? await this.verifyPassword(user.id, password) : await dummyVerify(password);
        if (valid) {
            this.attemptSucceeded(key);
            return true;
        }
        this.attemptFailed(key);
        await this.audit({
            event: 'login_failed',
            username: user?.name ?? attempted,
            userId: user?.id,
            actor: context.actor,
            actorId: context.actorId,
            details: user ? context.details ?? 'Wrong password' : 'User not found',
            metadata: { remoteAddress: context.remoteAddress },
        });
        return false;
    }

    // ---------------------------------------------------------------- users

    /** Resolves a user by id, name or email (case-insensitive). */
    async findUser(idNameOrEmail: string): Promise<User | undefined> {
        const user = await this.userStore.getUser(idNameOrEmail);
        if (user) {
            return user;
        }
        const lower = idNameOrEmail.toLowerCase();
        return (await this.userStore.getUsers()).find((u) => u.email?.toLowerCase() === lower);
    }

    /** Union of the permissions of the user's groups (group names are case-insensitive). */
    async getEffectivePermissions(user: User): Promise<string[]> {
        if (!this.groupStore) {
            return [];
        }
        const lists: string[][] = [];
        for (const name of user.groups ?? []) {
            const group = await this.groupStore.getGroup(name);
            if (group) {
                lists.push(group.permissions ?? []);
            }
        }
        return mergePermissions(...lists);
    }

    // -------------------------------------------------------------- sessions

    async login(username: string, password: string, metadata: SessionMetadata = {}): Promise<LoginResult> {
        const user = await this.findUser(username);
        const valid = await this.verifyPasswordWithLockout(user, password, {
            attemptedName: username,
            remoteAddress: metadata.remoteAddress,
        });
        if (!user || !valid) {
            throw unauthorized('invalid credentials');
        }

        if (user.disabled) {
            await this.audit({
                event: 'login_failed',
                username: user.name,
                userId: user.id,
                details: 'Account disabled',
                metadata: { remoteAddress: metadata.remoteAddress },
            });
            throw new HttpError(403, 'account disabled');
        }

        const liveUser = await this.userStore.updateUser(user.id, { lastLoginAt: Date.now() });

        const token = this.generateToken();
        const session = await this.sessionStore.createSession(user.id, hashToken(token), metadata);

        await this.audit({
            event: 'login',
            username: user.name,
            userId: user.id,
            details: 'Login successful',
            metadata: { remoteAddress: metadata.remoteAddress, sessionId: session.id },
        });

        const permissions = await this.getEffectivePermissions(liveUser);
        return { token, session: this.toSessionPayload(session, liveUser, permissions) };
    }

    /** Ends the session identified by the token hash. */
    async logout(tokenHash: string): Promise<void> {
        const session = await this.sessionStore.getSession(tokenHash);
        await this.sessionStore.deleteSession(tokenHash);
        if (!session) {
            return;
        }
        this.emitSessionEvent({ type: 'session-ended', sessionId: session.id, userId: session.userId, reason: 'logout' });
        const user = await this.userStore.getUser(session.userId);
        await this.audit({
            event: 'logout',
            username: user?.name ?? session.userId,
            userId: session.userId,
            details: 'User logged out',
            metadata: { sessionId: session.id },
        });
    }

    /** `min(lastActivity + idle timeout, createdAt + absolute lifetime)`. */
    expiresAt(session: Session): number {
        return Math.min(session.lastActivity + this.sessionTimeoutMs, session.createdAt + this.maxSessionLifetimeMs);
    }

    private isExpired(session: Session, now = Date.now()): boolean {
        return now > this.expiresAt(session);
    }

    /** Validates a stored session: expiry (deleted, 401) and live user (missing/disabled → 401). */
    private async validateSession(session: Session): Promise<{ user: User; permissions: string[] }> {
        if (this.isExpired(session)) {
            await this.sessionStore.deleteSession(session.tokenHash);
            this.emitSessionEvent({ type: 'session-ended', sessionId: session.id, userId: session.userId, reason: 'session expired' });
            throw unauthorized('session expired');
        }
        const user = await this.userStore.getUser(session.userId);
        if (!user || user.id !== session.userId || user.disabled) {
            await this.sessionStore.deleteSession(session.tokenHash);
            this.emitSessionEvent({ type: 'session-ended', sessionId: session.id, userId: session.userId, reason: 'user unavailable' });
            throw unauthorized('invalid or expired token');
        }
        return { user, permissions: await this.getEffectivePermissions(user) };
    }

    /**
     * Resolves a bearer token: checks idle/absolute expiry (expired → deleted,
     * 401), resolves the live user (missing/disabled → 401) and slides
     * `lastActivity`.
     */
    async authenticateToken(token: string): Promise<AuthContext> {
        if (isApiToken(token)) {
            return this.authenticateApiToken(token);
        }
        const tokenHash = hashToken(token);
        const session = await this.sessionStore.getSession(tokenHash);
        if (!session) {
            throw unauthorized('invalid or expired token');
        }
        const { user, permissions } = await this.validateSession(session);
        const now = Date.now();
        await this.sessionStore.updateLastActivity(tokenHash);
        session.lastActivity = now;
        return { user, permissions, session, tokenHash };
    }

    // ----------------------------------------------------------- api tokens

    /** Effective permissions of a token: the user's, narrowed to the scope entries the user still holds. */
    static scopePermissions(userPermissions: string[], scope: string[] | undefined): string[] {
        if (!scope) return userPermissions;
        return scope.filter((p) => hasPermission(userPermissions, p));
    }

    private static isTokenExpired(token: ApiToken, now = Date.now()): boolean {
        return token.expiresAt !== null && token.expiresAt !== undefined && now >= token.expiresAt;
    }

    /** Validates a stored token: not expired, live user enabled (401 otherwise). */
    private async validateApiToken(token: ApiToken): Promise<AuthContext> {
        if (AuthService.isTokenExpired(token)) {
            throw unauthorized('invalid or expired token');
        }
        const user = await this.userStore.getUser(token.userId);
        if (!user || user.id !== token.userId || user.disabled) {
            throw unauthorized('invalid or expired token');
        }
        const permissions = AuthService.scopePermissions(await this.getEffectivePermissions(user), token.permissions);
        return { user, permissions, apiToken: token };
    }

    /** Resolves an API bearer token (missing/expired/user unavailable → 401) and records its use. */
    async authenticateApiToken(token: string): Promise<AuthContext> {
        const stored = await this.apiTokenStore.getTokenByHash(hashToken(token));
        if (!stored) {
            throw unauthorized('invalid or expired token');
        }
        const ctx = await this.validateApiToken(stored);
        const now = Date.now();
        if (stored.lastUsedAt === undefined || stored.lastUsedAt === null || now - stored.lastUsedAt >= API_TOKEN_LAST_USED_INTERVAL_MS) {
            await this.apiTokenStore.updateLastUsed(stored.id, now);
            stored.lastUsedAt = now;
        }
        return ctx;
    }

    /** Re-validates a token identity (long-lived sockets); undefined when revoked, expired or the user is unavailable. */
    async revalidateApiToken(userId: string, apiTokenId: string): Promise<AuthContext | undefined> {
        const token = await this.apiTokenStore.getToken(apiTokenId);
        if (!token || token.userId !== userId) return undefined;
        try {
            return await this.validateApiToken(token);
        } catch {
            return undefined;
        }
    }

    toApiTokenView(token: ApiToken, userName: string): ApiTokenView {
        const view: ApiTokenView = {
            id: token.id,
            name: token.name,
            userId: token.userId,
            userName,
            createdAt: token.createdAt,
            expiresAt: token.expiresAt ?? null,
            lastUsedAt: token.lastUsedAt ?? null,
        };
        if (token.permissions) view.permissions = [...token.permissions];
        return view;
    }

    /** Tokens of `userId`, or every token when omitted, oldest first. */
    async listApiTokens(userId?: string): Promise<ApiToken[]> {
        const tokens = await this.apiTokenStore.getTokens(userId);
        return tokens.sort((a, b) => a.createdAt - b.createdAt);
    }

    /**
     * Creates an API token for the caller (session only). Validates the name
     * (400, duplicate 409), the expiry (1-365 days, default 90; `null` only with
     * `allowNonExpiringTokens`), the 20-token limit (400) and the scope (each entry
     * valid, 400, and covered by the caller's permissions, 403).
     */
    async createApiToken(ctx: AuthContext, body: Record<string, unknown>): Promise<{ token: string; apiToken: ApiToken }> {
        if (ctx.apiToken) {
            throw forbidden('forbidden: API tokens cannot create tokens');
        }
        if (!ctx.session) {
            throw new HttpError(501, 'Authentication is managed by the host application');
        }
        const name = body.name;
        if (typeof name !== 'string' || !API_TOKEN_NAME_RE.test(name)) {
            throw badRequest('name must be 1-64 characters of [A-Za-z0-9._ -]');
        }

        let expiresAt: number | null;
        const now = Date.now();
        const days = body.expiresInDays;
        if (days === undefined) {
            expiresAt = now + DEFAULT_API_TOKEN_EXPIRY_DAYS * DAY_MS;
        } else if (days === null) {
            if (!this.allowNonExpiringTokens) {
                throw badRequest('non-expiring tokens are not allowed');
            }
            expiresAt = null;
        } else if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_API_TOKEN_EXPIRY_DAYS) {
            throw badRequest(`expiresInDays must be an integer between 1 and ${MAX_API_TOKEN_EXPIRY_DAYS}`);
        } else {
            expiresAt = now + days * DAY_MS;
        }

        let permissions: string[] | undefined;
        if (body.permissions !== undefined && body.permissions !== null) {
            const value = body.permissions;
            if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
                throw badRequest('permissions must be an array of strings');
            }
            permissions = mergePermissions(validatePermissions(value as string[]));
            for (const p of permissions) {
                if (!hasPermission(ctx.permissions, p)) {
                    throw forbidden(`forbidden: cannot grant ${p}`);
                }
            }
        }

        const existing = await this.apiTokenStore.getTokens(ctx.user.id);
        if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
            throw conflict(`token '${name}' already exists`);
        }
        if (existing.filter((t) => !AuthService.isTokenExpired(t, now)).length >= MAX_API_TOKENS_PER_USER) {
            throw badRequest(`a user may have at most ${MAX_API_TOKENS_PER_USER} tokens`);
        }

        const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
        const apiToken = await this.apiTokenStore.createToken({
            id: randomUUID(),
            userId: ctx.user.id,
            name,
            tokenHash: hashToken(token),
            createdAt: now,
            expiresAt,
            ...(permissions ? { permissions } : {}),
        });
        await this.audit({
            event: 'token_created',
            username: ctx.user.name,
            userId: ctx.user.id,
            actor: ctx.user.name,
            actorId: ctx.user.id,
            details: `${apiToken.name} (${apiToken.id})`,
            metadata: { tokenId: apiToken.id, tokenName: apiToken.name },
        });
        return { token, apiToken };
    }

    /**
     * Revokes a token: the owner, or a caller holding `tokens:revoke`. Unknown
     * tokens and other users' tokens without the permission → 404.
     */
    async revokeApiToken(ctx: AuthContext, id: string, canRevokeAny: boolean): Promise<void> {
        const token = await this.apiTokenStore.getToken(id);
        if (!token || (token.userId !== ctx.user.id && !canRevokeAny)) {
            throw notFound('token not found');
        }
        await this.apiTokenStore.deleteToken(token.id);
        const ownerName = token.userId === ctx.user.id ? ctx.user.name : (await this.userStore.getUser(token.userId))?.name ?? token.userId;
        await this.audit({
            event: 'token_revoked',
            username: ownerName,
            userId: token.userId,
            actor: ctx.user.name,
            actorId: ctx.user.id,
            details: `${token.name} (${token.id})`,
            metadata: { tokenId: token.id, tokenName: token.name },
        });
        // Sockets opened with this token re-check their identity and close.
        this.emitSessionEvent({ type: 'access-changed', userId: token.userId });
    }

    /** Deletes every token of a user (user deletion). */
    async deleteUserTokens(userId: string): Promise<void> {
        await this.apiTokenStore.deleteUserTokens(userId);
        this.emitSessionEvent({ type: 'access-changed', userId });
    }

    // --------------------------------------------------------- ws tickets

    /** Issues a single-use WebSocket ticket bound to the caller's session (30 s). */
    issueTicket(ctx: AuthContext): { ticket: string; expiresIn: number } {
        this.sweepTickets();
        const ticket = randomBytes(32).toString('hex');
        this.tickets.set(hashToken(ticket), {
            expiresAt: Date.now() + WS_TICKET_TTL_SECONDS * 1000,
            userId: ctx.user.id,
            sessionId: ctx.session?.id,
            apiTokenId: ctx.apiToken?.id,
            adapterContext: ctx.session || ctx.apiToken ? undefined : ctx,
        });
        return { ticket, expiresIn: WS_TICKET_TTL_SECONDS };
    }

    /**
     * Consumes a ticket (single use). Returns the live context, or undefined when
     * invalid/expired. Throws 403 `password change required` when the user must
     * change their password first.
     */
    async consumeTicket(ticket: string): Promise<AuthContext | undefined> {
        if (typeof ticket !== 'string' || ticket.length === 0) return undefined;
        const key = hashToken(ticket);
        const entry = this.tickets.get(key);
        this.tickets.delete(key);
        if (!entry || Date.now() > entry.expiresAt) return undefined;

        if (entry.apiTokenId) {
            const fresh = await this.revalidateApiToken(entry.userId, entry.apiTokenId);
            if (!fresh) return undefined;
            if (fresh.user.mustChangePassword) {
                throw new HttpError(403, 'password change required');
            }
            return fresh;
        }
        if (!entry.sessionId) {
            return entry.adapterContext;
        }
        const session = await this.sessionStore.getSessionById(entry.sessionId);
        if (!session || session.userId !== entry.userId) return undefined;
        let validated: { user: User; permissions: string[] };
        try {
            validated = await this.validateSession(session);
        } catch {
            return undefined;
        }
        if (validated.user.mustChangePassword) {
            throw new HttpError(403, 'password change required');
        }
        return { ...validated, session, tokenHash: session.tokenHash };
    }

    /**
     * Re-validates an identity without sliding the session (used by long-lived
     * sockets such as the shell): the session still exists and is not expired,
     * the user exists, is enabled and has no pending password change. Adapter
     * identities (no session) only re-check the user. Undefined when ended.
     */
    async revalidate(userId: string, sessionId?: string, apiTokenId?: string): Promise<AuthContext | undefined> {
        if (apiTokenId) {
            const fresh = await this.revalidateApiToken(userId, apiTokenId);
            return fresh && !fresh.user.mustChangePassword ? fresh : undefined;
        }
        if (sessionId) {
            const session = await this.sessionStore.getSessionById(sessionId);
            if (!session || session.userId !== userId) return undefined;
            try {
                const { user, permissions } = await this.validateSession(session);
                if (user.mustChangePassword) return undefined;
                return { user, permissions, session, tokenHash: session.tokenHash };
            } catch {
                return undefined;
            }
        }
        const user = await this.userStore.getUser(userId);
        if (!user || user.id !== userId || user.disabled || user.mustChangePassword) return undefined;
        return { user, permissions: await this.getEffectivePermissions(user) };
    }

    /** Slides the idle expiry of a session (activity on a long-lived socket). */
    async touchSession(sessionId: string): Promise<void> {
        const session = await this.sessionStore.getSessionById(sessionId);
        if (session && !this.isExpired(session)) {
            await this.sessionStore.updateLastActivity(session.tokenHash);
        }
    }

    private sweepTickets(): void {
        const now = Date.now();
        for (const [k, v] of this.tickets) {
            if (now > v.expiresAt) this.tickets.delete(k);
        }
    }

    toSessionPayload(session: Session, user: User, permissions: string[]): SessionPayload {
        return {
            id: session.id,
            user: toUserJson(user),
            permissions,
            loginTime: session.createdAt,
            lastActivity: session.lastActivity,
            expiresAt: this.expiresAt(session),
        };
    }

    toSessionView(session: Session, userName: string, currentSessionId?: string): SessionView {
        const view: SessionView = {
            id: session.id,
            userId: session.userId,
            userName,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            expiresAt: this.expiresAt(session),
            metadata: {
                ...(session.metadata?.userAgent !== undefined ? { userAgent: session.metadata.userAgent } : {}),
                ...(session.metadata?.remoteAddress !== undefined ? { remoteAddress: session.metadata.remoteAddress } : {}),
            },
        };
        if (currentSessionId !== undefined) {
            view.current = session.id === currentSessionId;
        }
        return view;
    }

    /** Lists non-expired sessions (expired ones are removed). */
    async listSessions(): Promise<Session[]> {
        const now = Date.now();
        const sessions = await this.sessionStore.getActiveSessions();
        const live: Session[] = [];
        for (const s of sessions) {
            if (this.isExpired(s, now)) {
                await this.sessionStore.deleteSession(s.tokenHash);
                this.emitSessionEvent({ type: 'session-ended', sessionId: s.id, userId: s.userId, reason: 'session expired' });
            } else {
                live.push(s);
            }
        }
        return live;
    }

    async getSessionById(id: string): Promise<Session | undefined> {
        return this.sessionStore.getSessionById(id);
    }

    /** Deletes a session, audits `session_revoked` and broadcasts `session-kicked`. */
    async revokeSession(session: Session, reason: string, actor?: string, userName?: string, actorId?: string): Promise<void> {
        await this.sessionStore.deleteSessionById(session.id);
        this.emitSessionEvent({ type: 'session-ended', sessionId: session.id, userId: session.userId, reason, revoked: true });
        const name = userName ?? (await this.userStore.getUser(session.userId))?.name ?? session.userId;
        await this.audit({
            event: 'session_revoked',
            username: name,
            userId: session.userId,
            actor,
            actorId,
            details: reason,
            metadata: { sessionId: session.id },
        });
        try {
            this.broadcast?.({
                type: 'session-kicked',
                data: { sessionId: session.id, userId: session.userId, reason },
            });
        } catch (err) {
            console.error('[users] failed to broadcast session-kicked:', err);
        }
    }

    /** Revokes every session of a user, optionally keeping one. */
    async revokeUserSessions(
        userId: string,
        reason: string,
        options: { actor?: string; actorId?: string; exceptSessionId?: string; userName?: string } = {},
    ): Promise<number> {
        const sessions = (await this.sessionStore.getActiveSessions()).filter(
            (s) => s.userId === userId && s.id !== options.exceptSessionId,
        );
        for (const s of sessions) {
            await this.revokeSession(s, reason, options.actor, options.userName, options.actorId);
        }
        return sessions.length;
    }

    /**
     * Expired-session sweep: drops expired sessions (`session-ended` for each one
     * found), then lets open sockets re-check theirs (`access-changed`) in case
     * the store dropped some silently.
     */
    async cleanupExpiredSessions(): Promise<void> {
        await this.listSessions(); // idle and absolute expiry
        await this.sessionStore.cleanup(this.sessionTimeoutMs);
        this.sweepTickets();
        this.emitSessionEvent({ type: 'access-changed' });
    }
}

/** Serializes a user for the API: `disabled` always present, absent optionals omitted. */
export function toUserJson(user: User): User {
    const out: User = {
        id: user.id,
        name: user.name,
        email: user.email,
        groups: [...(user.groups ?? [])],
        disabled: !!user.disabled,
        mustChangePassword: !!user.mustChangePassword,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
    if (user.homeDir !== undefined && user.homeDir !== null) out.homeDir = user.homeDir;
    if (user.lastLoginAt !== undefined && user.lastLoginAt !== null) out.lastLoginAt = user.lastLoginAt;
    if (user.data !== undefined && user.data !== null) out.data = user.data;
    return out;
}
