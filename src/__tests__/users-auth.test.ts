import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService } from '../../plugins/users/services/auth-service';
import { InMemoryUserStore } from '../../plugins/users/stores/in-memory-user-store';
import { InMemorySessionStore } from '../../plugins/users/stores/in-memory-session-store';
import { InMemoryCredentialStore } from '../../plugins/users/stores/in-memory-credential-store';
import { InMemoryAuditStore } from '../../plugins/users/stores/in-memory-audit-store';

function buildAuthService() {
    const userStore = new InMemoryUserStore();
    const sessionStore = new InMemorySessionStore();
    const credentialStore = new InMemoryCredentialStore();
    const auditStore = new InMemoryAuditStore();
    const authService = new AuthService(userStore, sessionStore, credentialStore, auditStore);
    return { userStore, sessionStore, credentialStore, auditStore, authService };
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
        expect(result.session.userId).toBe(user.id);
    });

    it('throws for unknown username', async () => {
        const { authService } = buildAuthService();
        await expect(authService.login('nobody', 'pass', {}))
            .rejects.toThrow(/Invalid credentials/);
    });

    it('throws for wrong password', async () => {
        const { userStore, authService } = buildAuthService();
        const user = await userStore.createUser({ name: 'dave', email: 'dave@example.com' });
        await authService.setPassword(user.id, 'correct');
        await expect(authService.login('dave', 'wrong', {}))
            .rejects.toThrow(/Invalid credentials/);
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
