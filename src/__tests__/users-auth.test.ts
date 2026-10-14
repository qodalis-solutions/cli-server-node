import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService } from '../../plugins/users/services/auth-service';
import { InMemoryUserStore } from '../../plugins/users/stores/in-memory-user-store';
import { InMemorySessionStore } from '../../plugins/users/stores/in-memory-session-store';
import { InMemoryCredentialStore } from '../../plugins/users/stores/in-memory-credential-store';
import { InMemoryAuditStore } from '../../plugins/users/stores/in-memory-audit-store';
import { InMemoryGroupStore } from '../../plugins/users/stores/in-memory-group-store';
import { HttpError } from '../../plugins/users/errors';
import { createHash } from 'crypto';

function buildAuthService(options: { sessionTimeoutMs?: number; maxLoginAttempts?: number; lockoutMs?: number } = {}) {
    const userStore = new InMemoryUserStore();
    const sessionStore = new InMemorySessionStore();
    const credentialStore = new InMemoryCredentialStore();
    const auditStore = new InMemoryAuditStore();
    const groupStore = new InMemoryGroupStore();
    const authService = new AuthService(userStore, sessionStore, credentialStore, auditStore, { groupStore, ...options });
    return { userStore, sessionStore, credentialStore, auditStore, groupStore, authService };
}

// ---------------------------------------------------------------------------
// setPassword + verifyPassword
// ---------------------------------------------------------------------------

describe('AuthService.setPassword + verifyPassword', () => {
    it('verifies correct password after setting it', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'alice', email: 'alice@example.com' });
        await authService.setPassword(user.id, 'secret123');
        const valid = await authService.verifyPassword(user.id, 'secret123');
        expect(valid).toBe(true);
    });

    it('rejects wrong password', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'bob', email: 'bob@example.com' });
        await authService.setPassword(user.id, 'correct');
        const valid = await authService.verifyPassword(user.id, 'wrong');
        expect(valid).toBe(false);
    });

    it('returns false for unknown user (no credentials set)', async () => {
        const { authService } = buildAuthService();
        const valid = await authService.verifyPassword('no-such-user', 'pass');
        expect(valid).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe('AuthService.login', () => {
    it('logs in with valid credentials', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'carol', email: 'carol@example.com' });
        await authService.setPassword(user.id, 'mypassword');

        const result = await authService.login('carol', 'mypassword', {});
        expect(result.token).toBeDefined();
        expect(result.token.length).toBeGreaterThanOrEqual(32);
        expect(result.session).toBeDefined();
        expect(result.session.user.id).toBe(user.id);
    });

    it('throws for unknown username', async () => {
        const { authService } = buildAuthService();
        await expect(authService.login('nobody', 'pass', {}))
            .rejects.toThrow(/invalid credentials/i);
    });

    it('throws for wrong password', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'dave', email: 'dave@example.com' });
        await authService.setPassword(user.id, 'correct');
        await expect(authService.login('dave', 'wrong', {}))
            .rejects.toThrow(/invalid credentials/i);
    });

    it('throws for disabled user', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'eve', email: 'eve@example.com' });
        await authService.setPassword(user.id, 'pass');
        await userStore.updateUser(user.id, { disabled: true });
        await expect(authService.login('eve', 'pass', {}))
            .rejects.toThrow(/disabled/);
    });

    it('updates lastLoginAt on session user', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'frank', email: 'frank@example.com' });
        await authService.setPassword(user.id, 'pass');
        const before = Date.now();
        const result = await authService.login('frank', 'pass', {});
        expect(result.session.user.lastLoginAt).toBeGreaterThanOrEqual(before);
    });

    it('logs an audit entry on successful login', async () => {
        const { userStore, authService, auditStore } = buildAuthService();
        const user = await userStore.createUser({ name: 'grace', email: 'grace@example.com' });
        await authService.setPassword(user.id, 'pass');
        await authService.login('grace', 'pass', {});

        const entries = await auditStore.getEntries({ event: 'login', username: 'grace' });
        expect(entries).toHaveLength(1);
    });

    it('logs a failed audit entry on wrong password', async () => {
        const { userStore, authService, auditStore } = buildAuthService();
        const user = await userStore.createUser({ name: 'henry', email: 'henry@example.com' });
        await authService.setPassword(user.id, 'correct');

        try {
            await authService.login('henry', 'wrong', {});
        } catch {
            // expected
        }

        const entries = await auditStore.getEntries({ event: 'login_failed', username: 'henry' });
        expect(entries.length).toBeGreaterThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe('AuthService.logout', () => {
    it('deletes the session', async () => {
        const { userStore, sessionStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'ivan', email: 'ivan@example.com' });
        await authService.setPassword(user.id, 'pass');
        const { token } = await authService.login('ivan', 'pass', {});

        await authService.logout(token);
        const session = await sessionStore.getSession(token);
        expect(session).toBeUndefined();
    });

    it('logs a logout audit entry', async () => {
        const { userStore, authService, auditStore } = buildAuthService();
        const user = await userStore.createUser({ name: 'jane', email: 'jane@example.com' });
        await authService.setPassword(user.id, 'pass');
        const { token } = await authService.login('jane', 'pass', {});
        await authService.logout(token);

        const entries = await auditStore.getEntries({ event: 'logout' });
        expect(entries.length).toBeGreaterThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------

describe('AuthService.generateToken', () => {
    it('generates unique tokens', () => {
        const { authService } = buildAuthService();
        const t1 = authService.generateToken();
        const t2 = authService.generateToken();
        expect(t1).not.toBe(t2);
    });

    it('generates tokens of at least 32 chars', () => {
        const { authService } = buildAuthService();
        const token = authService.generateToken();
        expect(token.length).toBeGreaterThanOrEqual(32);
    });
});

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

describe('AuthService password hashing', () => {
    it('stores PBKDF2-SHA256 hashes as pbkdf2$100000$<salt>$<hash>', async () => {
        const { userStore, credentialStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'kate', email: 'kate@example.com' });
        await authService.setPassword(user.id, 'secret');
        const creds = await credentialStore.getCredentials(user.id);
        const parts = creds!.passwordHash.split('$');
        expect(parts).toHaveLength(4);
        expect(parts[0]).toBe('pbkdf2');
        expect(parts[1]).toBe('100000');
        expect(Buffer.from(parts[2], 'base64')).toHaveLength(16);
        expect(Buffer.from(parts[3], 'base64')).toHaveLength(32);
        expect(creds!.passwordHash).not.toContain('secret');
    });

    it('uses a random salt per password', async () => {
        const { userStore, credentialStore, authService } = buildAuthService();
        const a = await userStore.createUser({ name: 'a1', email: 'a1@example.com' });
        const b = await userStore.createUser({ name: 'b1', email: 'b1@example.com' });
        await authService.setPassword(a.id, 'same');
        await authService.setPassword(b.id, 'same');
        const ca = await credentialStore.getCredentials(a.id);
        const cb = await credentialStore.getCredentials(b.id);
        expect(ca!.passwordHash).not.toBe(cb!.passwordHash);
    });

    it('still verifies legacy sha256 credentials', async () => {
        const { userStore, credentialStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'legacy', email: 'legacy@example.com' });
        const salt = 'abcd';
        await credentialStore.setPassword(user.id, createHash('sha256').update(salt + 'old').digest('hex'), salt);
        expect(await authService.verifyPassword(user.id, 'old')).toBe(true);
        expect(await authService.verifyPassword(user.id, 'nope')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Login details: email login, lastLoginAt persistence, lockout
// ---------------------------------------------------------------------------

describe('AuthService login (contract)', () => {
    it('logs in by email', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'mail', email: 'Mail@Example.com' });
        await authService.setPassword(user.id, 'pass');
        const result = await authService.login('mail@example.com', 'pass', {});
        expect(result.session.user.id).toBe(user.id);
    });

    it('persists lastLoginAt through the user store', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'persist', email: 'persist@example.com' });
        await authService.setPassword(user.id, 'pass');
        await authService.login('persist', 'pass', {});
        const stored = await userStore.getUser(user.id);
        expect(stored!.lastLoginAt).toBeGreaterThan(0);
    });

    it('rejects a disabled user with 403 account disabled', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'off', email: 'off@example.com', disabled: true });
        await authService.setPassword(user.id, 'pass');
        const err = await authService.login('off', 'pass', {}).catch((e) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(403);
        expect(err.message).toBe('account disabled');
    });

    it('locks the account after maxLoginAttempts failures and resets on success', async () => {
        const { userStore, authService } = buildAuthService({ maxLoginAttempts: 3, lockoutMs: 60_000 });
        const user = await userStore.createUser({ name: 'lock', email: 'lock@example.com' });
        await authService.setPassword(user.id, 'pass');

        // two failures then a success resets the counter
        for (let i = 0; i < 2; i++) await authService.login('lock', 'bad', {}).catch(() => undefined);
        await authService.login('lock', 'pass', {});
        for (let i = 0; i < 2; i++) await authService.login('lock', 'bad', {}).catch(() => undefined);
        await authService.login('lock', 'pass', {});

        for (let i = 0; i < 3; i++) {
            const err = await authService.login('lock', 'bad', {}).catch((e) => e);
            expect(err.status).toBe(401);
        }
        const locked = await authService.login('lock', 'pass', {}).catch((e) => e);
        expect(locked.status).toBe(429);
        expect(locked.message).toBe('account locked, try again later');
        // lockout keyed by user: email login is locked too
        const byEmail = await authService.login('lock@example.com', 'pass', {}).catch((e) => e);
        expect(byEmail.status).toBe(429);
    });

    it('unlocks after lockoutMs', async () => {
        const { userStore, authService } = buildAuthService({ maxLoginAttempts: 1, lockoutMs: 30 });
        const user = await userStore.createUser({ name: 'brief', email: 'brief@example.com' });
        await authService.setPassword(user.id, 'pass');
        await authService.login('brief', 'bad', {}).catch(() => undefined);
        expect((await authService.login('brief', 'pass', {}).catch((e) => e)).status).toBe(429);
        await new Promise((r) => setTimeout(r, 40));
        const ok = await authService.login('brief', 'pass', {});
        expect(ok.token).toBeTruthy();
    });

    it('includes effective permissions from groups', async () => {
        const { userStore, groupStore, authService } = buildAuthService();
        await groupStore.createGroup({ name: 'Ops', permissions: ['deploy:run', 'users:read'] });
        await groupStore.createGroup({ name: 'readers', permissions: ['users:read', 'audit:read'] });
        const user = await userStore.createUser({ name: 'perm', email: 'perm@example.com', groups: ['ops', 'readers'] });
        await authService.setPassword(user.id, 'pass');
        const result = await authService.login('perm', 'pass', {});
        expect(result.session.permissions).toEqual(['deploy:run', 'users:read', 'audit:read']);
    });
});

// ---------------------------------------------------------------------------
// Token authentication: live user, idle expiry
// ---------------------------------------------------------------------------

describe('AuthService.authenticateToken', () => {
    it('resolves the live user on every call', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'live', email: 'live@example.com' });
        await authService.setPassword(user.id, 'pass');
        const { token } = await authService.login('live', 'pass', {});
        await userStore.updateUser(user.id, { email: 'changed@example.com' });
        const ctx = await authService.authenticateToken(token);
        expect(ctx.user.email).toBe('changed@example.com');
    });

    it('rejects and deletes idle-expired sessions', async () => {
        const { userStore, sessionStore, authService } = buildAuthService({ sessionTimeoutMs: 30 });
        const user = await userStore.createUser({ name: 'idle', email: 'idle@example.com' });
        await authService.setPassword(user.id, 'pass');
        const { token } = await authService.login('idle', 'pass', {});
        await new Promise((r) => setTimeout(r, 50));
        const err = await authService.authenticateToken(token).catch((e) => e);
        expect(err.status).toBe(401);
        expect(await sessionStore.getSession(token)).toBeUndefined();
    });

    it('rejects sessions of deleted users', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'gone', email: 'gone@example.com' });
        await authService.setPassword(user.id, 'pass');
        const { token } = await authService.login('gone', 'pass', {});
        await userStore.deleteUser(user.id);
        expect((await authService.authenticateToken(token).catch((e) => e)).status).toBe(401);
    });
});
