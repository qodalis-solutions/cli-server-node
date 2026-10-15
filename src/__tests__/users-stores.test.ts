import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryUserStore } from '../../plugins/users/stores/in-memory-user-store';
import { InMemorySessionStore } from '../../plugins/users/stores/in-memory-session-store';
import { InMemoryCredentialStore } from '../../plugins/users/stores/in-memory-credential-store';
import { InMemoryAuditStore } from '../../plugins/users/stores/in-memory-audit-store';
import { InMemoryGroupStore } from '../../plugins/users/stores/in-memory-group-store';
import { User } from '../../plugins/users/models';

// ---------------------------------------------------------------------------
// InMemoryUserStore
// ---------------------------------------------------------------------------

describe('InMemoryUserStore', () => {
    let store: InMemoryUserStore;

    beforeEach(() => {
        store = new InMemoryUserStore();
    });

    it('creates a user and returns it', async () => {
        const user = await store.createUser({ name: 'alice', email: 'alice@example.com' });
        expect(user.id).toBeDefined();
        expect(user.name).toBe('alice');
        expect(user.email).toBe('alice@example.com');
        expect(user.groups).toEqual([]);
        expect(user.createdAt).toBeDefined();
        expect(user.updatedAt).toBeDefined();
    });

    it('rejects duplicate user names (case-insensitive)', async () => {
        await store.createUser({ name: 'alice', email: 'alice@example.com' });
        await expect(store.createUser({ name: 'Alice', email: 'alice2@example.com' }))
            .rejects.toThrow(/already exists/);
    });

    it('gets user by id', async () => {
        const created = await store.createUser({ name: 'bob', email: 'bob@example.com' });
        const found = await store.getUser(created.id);
        expect(found).toBeDefined();
        expect(found!.id).toBe(created.id);
    });

    it('gets user by name (case-insensitive)', async () => {
        await store.createUser({ name: 'Carol', email: 'carol@example.com' });
        const found = await store.getUser('carol');
        expect(found).toBeDefined();
        expect(found!.name).toBe('Carol');
    });

    it('returns undefined for unknown user', async () => {
        const found = await store.getUser('nonexistent');
        expect(found).toBeUndefined();
    });

    it('lists all users', async () => {
        await store.createUser({ name: 'u1', email: 'u1@example.com' });
        await store.createUser({ name: 'u2', email: 'u2@example.com' });
        const users = await store.getUsers();
        expect(users).toHaveLength(2);
    });

    it('updates a user', async () => {
        const created = await store.createUser({ name: 'dave', email: 'dave@example.com' });
        const updated = await store.updateUser(created.id, { email: 'dave2@example.com', groups: ['admin'] });
        expect(updated.email).toBe('dave2@example.com');
        expect(updated.groups).toEqual(['admin']);
        expect(updated.name).toBe('dave');
    });

    it('throws when updating nonexistent user', async () => {
        await expect(store.updateUser('no-such-id', { email: 'x@x.com' }))
            .rejects.toThrow(/not found/);
    });

    it('deletes a user', async () => {
        const created = await store.createUser({ name: 'eve', email: 'eve@example.com' });
        await store.deleteUser(created.id);
        const found = await store.getUser(created.id);
        expect(found).toBeUndefined();
    });

    it('creates user with groups and data', async () => {
        const user = await store.createUser({
            name: 'frank',
            email: 'frank@example.com',
            groups: ['admin', 'devs'],
            data: { role: 'manager' },
        });
        expect(user.groups).toEqual(['admin', 'devs']);
        expect(user.data?.role).toBe('manager');
    });
});

// ---------------------------------------------------------------------------
// InMemorySessionStore
// ---------------------------------------------------------------------------

describe('InMemorySessionStore', () => {
    let store: InMemorySessionStore;
    const mockUser: User = {
        id: 'user-1',
        name: 'testuser',
        email: 'test@example.com',
        groups: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    beforeEach(() => {
        store = new InMemorySessionStore();
    });

    it('creates a session', async () => {
        const session = await store.createSession('user-1', 'token-abc', {
            remoteAddress: '127.0.0.1',
        });
        expect(session.id).toBeDefined();
        expect(session.tokenHash).toBe('token-abc');
        expect(session.userId).toBe('user-1');
        expect((session as any).user).toBeUndefined();
        expect(session.createdAt).toBeDefined();
        expect(session.lastActivity).toBeDefined();
    });

    it('gets session by token', async () => {
        await store.createSession('user-1', 'my-token', {});
        const found = await store.getSession('my-token');
        expect(found).toBeDefined();
        expect(found!.tokenHash).toBe('my-token');
    });

    it('gets session by id', async () => {
        const session = await store.createSession('user-1', 'tok', {});
        const found = await store.getSessionById(session.id);
        expect(found).toBeDefined();
        expect(found!.id).toBe(session.id);
    });

    it('returns undefined for unknown token', async () => {
        const found = await store.getSession('nonexistent');
        expect(found).toBeUndefined();
    });

    it('lists all active sessions', async () => {
        await store.createSession('user-1', 't1', {});
        await store.createSession('user-1', 't2', {});
        const sessions = await store.getActiveSessions();
        expect(sessions).toHaveLength(2);
    });

    it('deletes session by token', async () => {
        await store.createSession('user-1', 'tok-del', {});
        await store.deleteSession('tok-del');
        const found = await store.getSession('tok-del');
        expect(found).toBeUndefined();
    });

    it('deletes session by id', async () => {
        const session = await store.createSession('user-1', 'tok-by-id', {});
        await store.deleteSessionById(session.id);
        const found = await store.getSessionById(session.id);
        expect(found).toBeUndefined();
    });

    it('deletes all sessions for a user', async () => {
        await store.createSession('user-1', 'tok-a', {});
        await store.createSession('user-1', 'tok-b', {});
        await store.createSession('user-2', 'tok-c', {});
        await store.deleteUserSessions('user-1');
        const sessions = await store.getActiveSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].userId).toBe('user-2');
    });

    it('updates lastActivity', async () => {
        const session = await store.createSession('user-1', 'tok-act', {});
        const oldActivity = session.lastActivity;
        await new Promise((r) => setTimeout(r, 5));
        await store.updateLastActivity('tok-act');
        const updated = await store.getSession('tok-act');
        expect(updated!.lastActivity).toBeGreaterThan(oldActivity);
    });

    it('cleanup removes expired sessions', async () => {
        await store.createSession('user-1', 'tok-old', {});
        // Wait a bit, then clean up with a very short timeout
        await new Promise((r) => setTimeout(r, 10));
        await store.cleanup(5); // 5ms timeout
        const sessions = await store.getActiveSessions();
        expect(sessions).toHaveLength(0);
    });

    it('cleanup keeps non-expired sessions', async () => {
        await store.createSession('user-1', 'tok-fresh', {});
        await store.cleanup(60000); // 1 minute timeout
        const sessions = await store.getActiveSessions();
        expect(sessions).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// InMemoryCredentialStore
// ---------------------------------------------------------------------------

describe('InMemoryCredentialStore', () => {
    let store: InMemoryCredentialStore;

    beforeEach(() => {
        store = new InMemoryCredentialStore();
    });

    it('sets and gets credentials', async () => {
        await store.setPassword('user-1', 'hashvalue', 'mysalt');
        const creds = await store.getCredentials('user-1');
        expect(creds).toBeDefined();
        expect(creds!.userId).toBe('user-1');
        expect(creds!.passwordHash).toBe('hashvalue');
        expect(creds!.salt).toBe('mysalt');
        expect(creds!.lastChanged).toBeDefined();
    });

    it('returns undefined for unknown user', async () => {
        const creds = await store.getCredentials('nobody');
        expect(creds).toBeUndefined();
    });

    it('overwrites existing credentials', async () => {
        await store.setPassword('user-1', 'hash1', 'salt1');
        await store.setPassword('user-1', 'hash2', 'salt2');
        const creds = await store.getCredentials('user-1');
        expect(creds!.passwordHash).toBe('hash2');
        expect(creds!.salt).toBe('salt2');
    });

    it('deletes credentials', async () => {
        await store.setPassword('user-1', 'hash', 'salt');
        await store.deleteCredentials('user-1');
        const creds = await store.getCredentials('user-1');
        expect(creds).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// InMemoryAuditStore
// ---------------------------------------------------------------------------

describe('InMemoryAuditStore', () => {
    let store: InMemoryAuditStore;

    beforeEach(() => {
        store = new InMemoryAuditStore();
    });

    it('logs and retrieves entries', async () => {
        await store.log({ timestamp: Date.now(), event: 'login', username: 'alice' });
        await store.log({ timestamp: Date.now(), event: 'logout', username: 'alice' });
        const entries = await store.getEntries();
        expect(entries).toHaveLength(2);
    });

    it('returns entries newest-first', async () => {
        await store.log({ timestamp: 1000, event: 'login', username: 'alice' });
        await store.log({ timestamp: 2000, event: 'logout', username: 'alice' });
        const entries = await store.getEntries();
        expect(entries[0].timestamp).toBe(2000);
        expect(entries[1].timestamp).toBe(1000);
    });

    it('filters by event', async () => {
        await store.log({ timestamp: Date.now(), event: 'login', username: 'alice' });
        await store.log({ timestamp: Date.now(), event: 'logout', username: 'alice' });
        await store.log({ timestamp: Date.now(), event: 'login', username: 'bob' });
        const entries = await store.getEntries({ event: 'login' });
        expect(entries).toHaveLength(2);
        expect(entries.every((e) => e.event === 'login')).toBe(true);
    });

    it('filters by username', async () => {
        await store.log({ timestamp: Date.now(), event: 'login', username: 'alice' });
        await store.log({ timestamp: Date.now(), event: 'login', username: 'bob' });
        const entries = await store.getEntries({ username: 'alice' });
        expect(entries).toHaveLength(1);
        expect(entries[0].username).toBe('alice');
    });

    it('respects limit', async () => {
        for (let i = 0; i < 10; i++) {
            await store.log({ timestamp: Date.now(), event: 'login', username: 'user' });
        }
        const entries = await store.getEntries({ limit: 3 });
        expect(entries).toHaveLength(3);
    });

    it('clears all entries', async () => {
        await store.log({ timestamp: Date.now(), event: 'login', username: 'alice' });
        await store.clear();
        const entries = await store.getEntries();
        expect(entries).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// InMemoryGroupStore
// ---------------------------------------------------------------------------

describe('InMemoryGroupStore', () => {
    let store: InMemoryGroupStore;

    beforeEach(() => {
        store = new InMemoryGroupStore();
    });

    it('creates and gets a group', async () => {
        const group = await store.createGroup({ name: 'admin', description: 'Administrators' });
        expect(group.id).toBeDefined();
        expect(group.name).toBe('admin');
        expect(group.description).toBe('Administrators');
        expect(group.createdAt).toBeDefined();

        const found = await store.getGroup('admin');
        expect(found).toBeDefined();
        expect(found!.name).toBe('admin');
    });

    it('rejects duplicate group names', async () => {
        await store.createGroup({ name: 'admin' });
        await expect(store.createGroup({ name: 'admin' })).rejects.toThrow(/already exists/);
    });

    it('lists all groups', async () => {
        await store.createGroup({ name: 'admin' });
        await store.createGroup({ name: 'devs' });
        const groups = await store.getGroups();
        expect(groups).toHaveLength(2);
    });

    it('returns undefined for unknown group', async () => {
        const found = await store.getGroup('nonexistent');
        expect(found).toBeUndefined();
    });

    it('looks up groups case-insensitively and keeps the given name', async () => {
        await store.createGroup({ name: 'DevOps', permissions: ['deploy:*'] });
        const found = await store.getGroup('devops');
        expect(found!.name).toBe('DevOps');
        expect(found!.permissions).toEqual(['deploy:*']);
        expect(found!.builtIn).toBe(false);
        await expect(store.createGroup({ name: 'DEVOPS' })).rejects.toThrow(/already exists/);
    });

    it('updates description and permissions', async () => {
        await store.createGroup({ name: 'ops' });
        const updated = await store.updateGroup('OPS', { description: 'Ops', permissions: ['a:b'] });
        expect(updated.description).toBe('Ops');
        expect(updated.permissions).toEqual(['a:b']);
        expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
    });

    it('deletes a group', async () => {
        await store.createGroup({ name: 'temp' });
        await store.deleteGroup('temp');
        const found = await store.getGroup('temp');
        expect(found).toBeUndefined();
    });
});
