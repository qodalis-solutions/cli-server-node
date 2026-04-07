import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildUsersPlugin, UsersPluginResult } from '../../plugins/users/index';

describe('Users API Integration', () => {
    let app: express.Express;
    let plugin: UsersPluginResult;
    let adminToken: string;
    let adminUserId: string;

    beforeAll(async () => {
        app = express();
        app.use(express.json());
        plugin = await buildUsersPlugin({ defaultAdminPassword: 'admin123' });
        app.use(plugin.prefix, plugin.router);

        // Login as admin to get token
        const res = await request(app)
            .post('/api/v1/qcli/auth/login')
            .send({ username: 'root', password: 'admin123' });
        adminToken = res.body.token;
        adminUserId = res.body.session?.userId;
    });

    afterAll(() => {
        plugin.dispose();
    });

    // -------------------------------------------------------------------------
    // Auth
    // -------------------------------------------------------------------------

    describe('POST /auth/login', () => {
        it('returns 200 with token and session for valid credentials', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'root', password: 'admin123' });

            expect(res.status).toBe(200);
            expect(res.body.token).toBeDefined();
            expect(res.body.session).toBeDefined();
            expect(res.body.session.userId).toBeDefined();
        });

        it('returns 401 for invalid credentials', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'root', password: 'wrongpassword' });

            expect(res.status).toBe(401);
            expect(res.body.error).toBeDefined();
        });

        it('returns 401 for unknown username', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'nobody', password: 'pass' });

            expect(res.status).toBe(401);
        });

        it('returns 400 when username is missing', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ password: 'admin123' });

            expect(res.status).toBe(400);
        });

        it('returns 400 when password is missing', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'root' });

            expect(res.status).toBe(400);
        });

        it('returns 401 for disabled user account', async () => {
            // Create a user, disable via PUT, then try login
            const createRes = await request(app)
                .post('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'disableduser', email: 'disabled@example.com', password: 'disabledpass' });
            const userId = createRes.body.id;

            await request(app)
                .put(`/api/v1/qcli/users/${userId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ disabled: true });

            const loginRes = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'disableduser', password: 'disabledpass' });

            expect(loginRes.status).toBe(401);
            expect(loginRes.body.error).toBeDefined();
        });
    });

    describe('POST /auth/logout', () => {
        it('returns 204 and invalidates the session', async () => {
            // Create a separate login session to logout
            const loginRes = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'root', password: 'admin123' });

            const tempToken = loginRes.body.token;

            const logoutRes = await request(app)
                .post('/api/v1/qcli/auth/logout')
                .set('Authorization', `Bearer ${tempToken}`);

            expect(logoutRes.status).toBe(204);

            // Token should no longer work
            const usersRes = await request(app)
                .get('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${tempToken}`);

            expect(usersRes.status).toBe(401);
        });

        it('returns 401 without a token', async () => {
            const res = await request(app).post('/api/v1/qcli/auth/logout');
            expect(res.status).toBe(401);
        });
    });

    describe('POST /auth/verify', () => {
        it('returns { valid: true } for correct password', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/verify')
                .send({ userId: adminUserId, password: 'admin123' });

            expect(res.status).toBe(200);
            expect(res.body.valid).toBe(true);
        });

        it('returns { valid: false } for wrong password', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/verify')
                .send({ userId: adminUserId, password: 'wrongpassword' });

            expect(res.status).toBe(200);
            expect(res.body.valid).toBe(false);
        });

        it('returns 400 when userId is missing', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/verify')
                .send({ password: 'admin123' });

            expect(res.status).toBe(400);
        });

        it('returns 400 when password is missing', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/auth/verify')
                .send({ userId: adminUserId });

            expect(res.status).toBe(400);
        });
    });

    // -------------------------------------------------------------------------
    // Users
    // -------------------------------------------------------------------------

    describe('GET /users', () => {
        it('returns 401 without auth token', async () => {
            const res = await request(app).get('/api/v1/qcli/users');
            expect(res.status).toBe(401);
        });

        it('returns 200 with list of users when authenticated', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body.length).toBeGreaterThan(0);
        });
    });

    describe('POST /users', () => {
        it('admin can create a new user (201)', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'alice', email: 'alice@example.com', password: 'alicepass' });

            expect(res.status).toBe(201);
            expect(res.body.name).toBe('alice');
            expect(res.body.id).toBeDefined();
        });

        it('returns 409 for duplicate username', async () => {
            // alice was already created above
            const res = await request(app)
                .post('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'alice', email: 'alice2@example.com' });

            expect(res.status).toBe(409);
        });

        it('returns 400 when name is missing', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ email: 'noemail@example.com' });

            expect(res.status).toBe(400);
        });

        it('returns 400 when email is missing', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'noemailuser' });

            expect(res.status).toBe(400);
        });
    });

    describe('GET /users/:idOrName', () => {
        it('returns user by username', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/users/root')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(res.body.name).toBe('root');
        });

        it('returns 404 for unknown user', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/users/no-such-user')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(404);
        });
    });

    describe('PUT /users/:id', () => {
        it('admin can update user email', async () => {
            // First get alice's id
            const getRes = await request(app)
                .get('/api/v1/qcli/users/alice')
                .set('Authorization', `Bearer ${adminToken}`);

            const aliceId = getRes.body.id;

            const res = await request(app)
                .put(`/api/v1/qcli/users/${aliceId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ email: 'alice-updated@example.com' });

            expect(res.status).toBe(200);
            expect(res.body.email).toBe('alice-updated@example.com');
        });

        it('returns 404 for non-existent user id', async () => {
            const res = await request(app)
                .put('/api/v1/qcli/users/non-existent-id')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ email: 'test@example.com' });

            expect(res.status).toBe(404);
        });
    });

    describe('DELETE /users/:id', () => {
        it('admin can delete a user (204)', async () => {
            // Create a user to delete
            const createRes = await request(app)
                .post('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'deleteme', email: 'deleteme@example.com' });

            const userId = createRes.body.id;

            const deleteRes = await request(app)
                .delete(`/api/v1/qcli/users/${userId}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(deleteRes.status).toBe(204);

            // User should no longer exist
            const getRes = await request(app)
                .get(`/api/v1/qcli/users/${userId}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(getRes.status).toBe(404);
        });
    });

    describe('PUT /users/:id/password', () => {
        it('admin can change another user password without currentPassword', async () => {
            const getRes = await request(app)
                .get('/api/v1/qcli/users/alice')
                .set('Authorization', `Bearer ${adminToken}`);
            const aliceId = getRes.body.id;

            const res = await request(app)
                .put(`/api/v1/qcli/users/${aliceId}/password`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ newPassword: 'newAlicePass' });

            expect(res.status).toBe(200);
            expect(res.body.message).toBeDefined();
        });

        it('user can change own password with currentPassword', async () => {
            // Get alice's id and log in as alice
            const getRes = await request(app)
                .get('/api/v1/qcli/users/alice')
                .set('Authorization', `Bearer ${adminToken}`);
            const aliceId = getRes.body.id;

            // Login as alice with newAlicePass set above
            const loginRes = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'alice', password: 'newAlicePass' });
            const aliceToken = loginRes.body.token;

            const res = await request(app)
                .put(`/api/v1/qcli/users/${aliceId}/password`)
                .set('Authorization', `Bearer ${aliceToken}`)
                .send({ currentPassword: 'newAlicePass', newPassword: 'alicepass2' });

            expect(res.status).toBe(200);
        });

        it('returns 401 when self-change currentPassword is wrong', async () => {
            const loginRes = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'alice', password: 'alicepass2' });
            const aliceToken = loginRes.body.token;
            const aliceId = loginRes.body.session.userId;

            const res = await request(app)
                .put(`/api/v1/qcli/users/${aliceId}/password`)
                .set('Authorization', `Bearer ${aliceToken}`)
                .send({ currentPassword: 'wrongcurrent', newPassword: 'newpass' });

            expect(res.status).toBe(401);
        });

        it('returns 400 when newPassword is missing', async () => {
            const getRes = await request(app)
                .get('/api/v1/qcli/users/alice')
                .set('Authorization', `Bearer ${adminToken}`);
            const aliceId = getRes.body.id;

            const res = await request(app)
                .put(`/api/v1/qcli/users/${aliceId}/password`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ currentPassword: 'alicepass2' });

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('newPassword');
        });

        it('returns 400 when non-admin self-change is missing currentPassword', async () => {
            const loginRes = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'alice', password: 'alicepass2' });
            const aliceToken = loginRes.body.token;
            const aliceId = loginRes.body.session.userId;

            const res = await request(app)
                .put(`/api/v1/qcli/users/${aliceId}/password`)
                .set('Authorization', `Bearer ${aliceToken}`)
                .send({ newPassword: 'newpass' });

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('currentPassword');
        });
    });

    // -------------------------------------------------------------------------
    // Sessions
    // -------------------------------------------------------------------------

    describe('GET /sessions', () => {
        it('admin can list active sessions', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/sessions')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    describe('GET /sessions/current', () => {
        it('returns current session for authenticated user', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/sessions/current')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(res.body.token).toBe(adminToken);
        });
    });

    describe('DELETE /sessions/:id', () => {
        it('admin can kick another session, and that token no longer works', async () => {
            // Login as alice to get her session
            const loginRes = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'alice', password: 'alicepass2' });
            const aliceToken = loginRes.body.token;
            const aliceSessionId = loginRes.body.session.id;

            // Admin kicks alice's session
            const kickRes = await request(app)
                .delete(`/api/v1/qcli/sessions/${aliceSessionId}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(kickRes.status).toBe(204);

            // Alice's token should no longer work
            const usersRes = await request(app)
                .get('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${aliceToken}`);

            expect(usersRes.status).toBe(401);
        });

        it('returns 404 for non-existent session id', async () => {
            const res = await request(app)
                .delete('/api/v1/qcli/sessions/no-such-session-id')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------------
    // Groups
    // -------------------------------------------------------------------------

    describe('POST /groups', () => {
        it('admin can create a group (201)', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/groups')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'editors', description: 'Content editors' });

            expect(res.status).toBe(201);
            expect(res.body.name).toBe('editors');
        });

        it('returns 409 for duplicate group name', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/groups')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'editors' });

            expect(res.status).toBe(409);
        });

        it('returns 400 when name is missing', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/groups')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ description: 'A group without a name' });

            expect(res.status).toBe(400);
        });
    });

    describe('GET /groups', () => {
        it('returns list of groups', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/groups')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    describe('GET /groups/:name', () => {
        it('returns group by name', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/groups/editors')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(res.body.name).toBe('editors');
        });

        it('returns 404 for unknown group', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/groups/no-such-group')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(404);
        });
    });

    describe('PUT /groups/:name/members/:userId', () => {
        it('admin can add user to group', async () => {
            const getRes = await request(app)
                .get('/api/v1/qcli/users/alice')
                .set('Authorization', `Bearer ${adminToken}`);
            const aliceId = getRes.body.id;

            const res = await request(app)
                .put(`/api/v1/qcli/groups/editors/members/${aliceId}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
        });

        it('returns 404 for non-existent group', async () => {
            const getRes = await request(app)
                .get('/api/v1/qcli/users/alice')
                .set('Authorization', `Bearer ${adminToken}`);
            const aliceId = getRes.body.id;

            const res = await request(app)
                .put(`/api/v1/qcli/groups/no-such-group/members/${aliceId}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(404);
        });
    });

    describe('DELETE /groups/:name/members/:userId', () => {
        it('admin can remove user from group', async () => {
            const getRes = await request(app)
                .get('/api/v1/qcli/users/alice')
                .set('Authorization', `Bearer ${adminToken}`);
            const aliceId = getRes.body.id;

            const res = await request(app)
                .delete(`/api/v1/qcli/groups/editors/members/${aliceId}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
        });
    });

    describe('DELETE /groups/:name', () => {
        it('admin can delete a group (204)', async () => {
            // Create a disposable group first
            await request(app)
                .post('/api/v1/qcli/groups')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'tempgroup' });

            const res = await request(app)
                .delete('/api/v1/qcli/groups/tempgroup')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(204);
        });
    });

    // -------------------------------------------------------------------------
    // Audit
    // -------------------------------------------------------------------------

    describe('GET /audit', () => {
        it('admin can list audit entries', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/audit')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body.length).toBeGreaterThan(0);
        });

        it('can filter audit entries by event', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/audit?event=login')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            res.body.forEach((entry: { event: string }) => {
                expect(entry.event).toBe('login');
            });
        });

        it('returns 401 without auth', async () => {
            const res = await request(app).get('/api/v1/qcli/audit');
            expect(res.status).toBe(401);
        });
    });

    describe('DELETE /audit', () => {
        it('admin can clear audit log (204)', async () => {
            const res = await request(app)
                .delete('/api/v1/qcli/audit')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(204);

            // Verify it's empty now
            const getRes = await request(app)
                .get('/api/v1/qcli/audit')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(getRes.body).toHaveLength(0);
        });
    });

    // -------------------------------------------------------------------------
    // Non-admin access (bob)
    // -------------------------------------------------------------------------

    describe('Non-admin user (bob)', () => {
        let bobToken: string;
        let bobUserId: string;
        let bobSessionId: string;

        beforeAll(async () => {
            // Admin creates bob
            await request(app)
                .post('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'bob', email: 'bob@example.com', password: 'bobpass' });

            // Bob logs in
            const loginRes = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'bob', password: 'bobpass' });
            bobToken = loginRes.body.token;
            bobUserId = loginRes.body.session.userId;
            bobSessionId = loginRes.body.session.id;
        });

        it('cannot create users (403)', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/users')
                .set('Authorization', `Bearer ${bobToken}`)
                .send({ name: 'charlie', email: 'charlie@example.com' });

            expect(res.status).toBe(403);
        });

        it('cannot list all sessions (403)', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/sessions')
                .set('Authorization', `Bearer ${bobToken}`);

            expect(res.status).toBe(403);
        });

        it('can get own session (200)', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/sessions/current')
                .set('Authorization', `Bearer ${bobToken}`);

            expect(res.status).toBe(200);
            expect(res.body.id).toBe(bobSessionId);
        });

        it('cannot access audit log (403)', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/audit')
                .set('Authorization', `Bearer ${bobToken}`);

            expect(res.status).toBe(403);
        });

        it('cannot delete groups (403)', async () => {
            const res = await request(app)
                .delete('/api/v1/qcli/groups/admin')
                .set('Authorization', `Bearer ${bobToken}`);

            expect(res.status).toBe(403);
        });

        it('cannot change another user password (403)', async () => {
            const res = await request(app)
                .put(`/api/v1/qcli/users/${adminUserId}/password`)
                .set('Authorization', `Bearer ${bobToken}`)
                .send({ newPassword: 'hackedpass' });

            expect(res.status).toBe(403);
        });

        it('cannot create groups (403)', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/groups')
                .set('Authorization', `Bearer ${bobToken}`)
                .send({ name: 'bobgroup', description: 'Should fail' });

            expect(res.status).toBe(403);
        });

        it('cannot add members to groups (403)', async () => {
            const res = await request(app)
                .put(`/api/v1/qcli/groups/editors/members/${bobUserId}`)
                .set('Authorization', `Bearer ${bobToken}`);

            expect(res.status).toBe(403);
        });

        it('cannot kick another session (403)', async () => {
            // Create a temporary login session to target
            const loginRes = await request(app)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'root', password: 'admin123' });
            const targetSessionId = loginRes.body.session.id;

            const res = await request(app)
                .delete(`/api/v1/qcli/sessions/${targetSessionId}`)
                .set('Authorization', `Bearer ${bobToken}`);

            expect(res.status).toBe(403);
        });

        it('cannot clear audit log (403)', async () => {
            const res = await request(app)
                .delete('/api/v1/qcli/audit')
                .set('Authorization', `Bearer ${bobToken}`);

            expect(res.status).toBe(403);
        });
    });

    // -------------------------------------------------------------------------
    // Audit (additional edge cases)
    // -------------------------------------------------------------------------

    describe('GET /audit (filters)', () => {
        it('can filter audit entries by username', async () => {
            const res = await request(app)
                .get('/api/v1/qcli/audit?username=root')
                .set('Authorization', `Bearer ${adminToken}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            res.body.forEach((entry: { username: string }) => {
                expect(entry.username).toBe('root');
            });
        });
    });
});
