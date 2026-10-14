import { randomBytes } from 'crypto';
import {
    ICliUserStore,
    ICliSessionStore,
    ICliCredentialStore,
    ICliAuditStore,
    ICliGroupStore,
} from '../stores/interfaces';
import {
    AuditEntry,
    LoginResult,
    Session,
    SessionMetadata,
    SessionPayload,
    SessionView,
    User,
    UsersBroadcastFn,
} from '../models';
import { HttpError, badRequest, unauthorized } from '../errors';
import { hashPassword, verifyPasswordHash } from './password-hasher';
import { mergePermissions } from '../permissions';

export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
export const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000;
export const DEFAULT_MIN_PASSWORD_LENGTH = 4;

export const LOCKED_MESSAGE = 'account locked, try again later';

export interface AuthServiceOptions {
    /** Used to compute effective permissions. Without it users have no permissions. */
    groupStore?: ICliGroupStore;
    sessionTimeoutMs?: number;
    maxLoginAttempts?: number;
    lockoutMs?: number;
    minPasswordLength?: number;
    /** Broadcasts `session-kicked` events over the events socket. */
    broadcast?: UsersBroadcastFn;
}

/** An authenticated request context: the live user plus, for token auth, the session. */
export interface AuthContext {
    user: User;
    permissions: string[];
    /** Absent for external-auth (adapter) requests. */
    session?: Session;
    token?: string;
}

interface LockoutState {
    failures: number;
    lockedUntil: number;
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
    private readonly groupStore?: ICliGroupStore;
    private broadcast?: UsersBroadcastFn;
    private readonly lockouts = new Map<string, LockoutState>();

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
        this.broadcast = options.broadcast;
    }

    setBroadcast(fn: UsersBroadcastFn | undefined): void {
        this.broadcast = fn;
    }

    generateToken(): string {
        return randomBytes(32).toString('hex');
    }

    // ---------------------------------------------------------------- audit

    async audit(entry: Omit<AuditEntry, 'timestamp'> & { timestamp?: number }): Promise<void> {
        const clean: AuditEntry = { timestamp: entry.timestamp ?? Date.now(), event: entry.event, username: entry.username };
        if (entry.id !== undefined) clean.id = entry.id;
        if (entry.details !== undefined) clean.details = entry.details;
        if (entry.actor !== undefined) clean.actor = entry.actor;
        if (entry.metadata !== undefined) {
            const metadata = Object.fromEntries(Object.entries(entry.metadata).filter(([, v]) => v !== undefined));
            if (Object.keys(metadata).length > 0) clean.metadata = metadata;
        }
        await this.auditStore.log(clean);
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
        this.lockouts.delete(userId);
    }

    // -------------------------------------------------------------- lockout

    isLocked(userId: string): boolean {
        const state = this.lockouts.get(userId);
        if (!state || state.lockedUntil === 0) {
            return false;
        }
        if (Date.now() >= state.lockedUntil) {
            this.lockouts.delete(userId);
            return false;
        }
        return true;
    }

    private recordFailure(userId: string): void {
        const state = this.lockouts.get(userId) ?? { failures: 0, lockedUntil: 0 };
        state.failures += 1;
        if (state.failures >= this.maxLoginAttempts) {
            state.lockedUntil = Date.now() + this.lockoutMs;
        }
        this.lockouts.set(userId, state);
    }

    private resetFailures(userId: string): void {
        this.lockouts.delete(userId);
    }

    /**
     * Verifies a user's password, applying lockout: throws 429 while locked,
     * counts failures, resets on success. Failures are audited as `login_failed`.
     */
    async verifyPasswordWithLockout(
        user: User,
        password: string,
        context: { actor?: string; remoteAddress?: string; details?: string } = {},
    ): Promise<boolean> {
        if (this.isLocked(user.id)) {
            await this.audit({
                event: 'login_failed',
                username: user.name,
                actor: context.actor,
                details: 'Account locked',
                metadata: { remoteAddress: context.remoteAddress },
            });
            throw new HttpError(429, LOCKED_MESSAGE);
        }
        const valid = await this.verifyPassword(user.id, password);
        if (valid) {
            this.resetFailures(user.id);
        } else {
            this.recordFailure(user.id);
            await this.audit({
                event: 'login_failed',
                username: user.name,
                actor: context.actor,
                details: context.details ?? 'Wrong password',
                metadata: { remoteAddress: context.remoteAddress },
            });
        }
        return valid;
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
        if (!user) {
            await this.audit({
                event: 'login_failed',
                username,
                details: 'User not found',
                metadata: { remoteAddress: metadata.remoteAddress },
            });
            throw unauthorized('invalid credentials');
        }

        const valid = await this.verifyPasswordWithLockout(user, password, { remoteAddress: metadata.remoteAddress });
        if (!valid) {
            throw unauthorized('invalid credentials');
        }

        if (user.disabled) {
            await this.audit({
                event: 'login_failed',
                username: user.name,
                details: 'Account disabled',
                metadata: { remoteAddress: metadata.remoteAddress },
            });
            throw new HttpError(403, 'account disabled');
        }

        const liveUser = await this.userStore.updateUser(user.id, { lastLoginAt: Date.now() });

        const token = this.generateToken();
        const session = await this.sessionStore.createSession(user.id, token, metadata);

        await this.audit({
            event: 'login',
            username: user.name,
            details: 'Login successful',
            metadata: { remoteAddress: metadata.remoteAddress, sessionId: session.id },
        });

        const permissions = await this.getEffectivePermissions(liveUser);
        return { token, session: this.toSessionPayload(session, liveUser, permissions) };
    }

    async logout(token: string): Promise<void> {
        const session = await this.sessionStore.getSession(token);
        await this.sessionStore.deleteSession(token);
        if (!session) {
            return;
        }
        const user = await this.userStore.getUser(session.userId);
        await this.audit({
            event: 'logout',
            username: user?.name ?? session.userId,
            details: 'User logged out',
            metadata: { sessionId: session.id },
        });
    }

    /**
     * Resolves a bearer token: checks idle expiry (expired → deleted, 401),
     * resolves the live user (missing/disabled → 401) and slides `lastActivity`.
     */
    async authenticateToken(token: string): Promise<AuthContext> {
        const session = await this.sessionStore.getSession(token);
        if (!session) {
            throw unauthorized('invalid or expired token');
        }

        const now = Date.now();
        if (now - session.lastActivity > this.sessionTimeoutMs) {
            await this.sessionStore.deleteSession(token);
            throw unauthorized('session expired');
        }

        const user = await this.userStore.getUser(session.userId);
        if (!user || user.id !== session.userId || user.disabled) {
            await this.sessionStore.deleteSession(token);
            throw unauthorized('invalid or expired token');
        }

        await this.sessionStore.updateLastActivity(token);
        session.lastActivity = now;

        return { user, permissions: await this.getEffectivePermissions(user), session, token };
    }

    toSessionPayload(session: Session, user: User, permissions: string[]): SessionPayload {
        return {
            id: session.id,
            user: toUserJson(user),
            permissions,
            loginTime: session.createdAt,
            lastActivity: session.lastActivity,
            expiresAt: session.lastActivity + this.sessionTimeoutMs,
        };
    }

    toSessionView(session: Session, userName: string, currentSessionId?: string): SessionView {
        const view: SessionView = {
            id: session.id,
            userId: session.userId,
            userName,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            expiresAt: session.lastActivity + this.sessionTimeoutMs,
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
            if (now - s.lastActivity > this.sessionTimeoutMs) {
                await this.sessionStore.deleteSession(s.token);
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
    async revokeSession(session: Session, reason: string, actor?: string, userName?: string): Promise<void> {
        await this.sessionStore.deleteSessionById(session.id);
        const name = userName ?? (await this.userStore.getUser(session.userId))?.name ?? session.userId;
        await this.audit({
            event: 'session_revoked',
            username: name,
            actor,
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
        options: { actor?: string; exceptSessionId?: string; userName?: string } = {},
    ): Promise<number> {
        const sessions = (await this.sessionStore.getActiveSessions()).filter(
            (s) => s.userId === userId && s.id !== options.exceptSessionId,
        );
        for (const s of sessions) {
            await this.revokeSession(s, reason, options.actor, options.userName);
        }
        return sessions.length;
    }

    async cleanupExpiredSessions(): Promise<void> {
        await this.sessionStore.cleanup(this.sessionTimeoutMs);
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
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
    if (user.homeDir !== undefined && user.homeDir !== null) out.homeDir = user.homeDir;
    if (user.lastLoginAt !== undefined && user.lastLoginAt !== null) out.lastLoginAt = user.lastLoginAt;
    if (user.data !== undefined && user.data !== null) out.data = user.data;
    return out;
}
