/**
 * Regression: the users plugin and the admin plugin are both mounted at
 * /api/v1/qcli in the demo server. Their auth endpoints must not collide —
 * the admin dashboard keeps /auth/login, the users plugin logs in via POST /sessions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { CliEventSocketManager } from '../services/cli-event-socket-manager';
import { CliBuilder } from '../extensions/cli-builder';

const ADMIN_USER = 'dashadmin';
const ADMIN_PASS = 'dashpass';
const USERS_ROOT_PASS = 'rootpass';

let app: Express;
let adminPlugin: CliAdminPluginResult;
let usersPlugin: UsersPluginResult;

beforeAll(async () => {
    const registry = new CliCommandRegistry();
    const builder = new CliBuilder(registry);
    const eventSocketManager = new CliEventSocketManager();

    adminPlugin = new CliAdminBuilder()
        .setCredentials(ADMIN_USER, ADMIN_PASS)
        .setJwtSecret('coexistence-test-secret')
        .build({ registry, eventSocketManager, builder, broadcastFn: () => {} });
    usersPlugin = new CliUsersBuilder().setDefaultAdminPassword(USERS_ROOT_PASS).build();
    await usersPlugin.ready;

    app = express();
    app.use(express.json());
    // Same order as demo/src/index.ts: admin first, then users
    app.use(adminPlugin.prefix, adminPlugin.router);
    app.use(usersPlugin.prefix, usersPlugin.router);
});

afterAll(() => {
    adminPlugin?.logBuffer.restoreConsole();
    usersPlugin?.dispose();
});

describe('users + admin plugins mounted together', () => {
    it('users plugin login works at POST /sessions', async () => {
        const res = await request(app)
            .post('/api/v1/qcli/sessions')
            .send({ username: 'root', password: USERS_ROOT_PASS });
        expect(res.status).toBe(201);
        expect(res.body.token).toBeTruthy();
        expect(res.body.session.user.name).toBe('root');
    });

    it('admin dashboard login still works at /auth/login', async () => {
        const res = await request(app)
            .post('/api/v1/qcli/auth/login')
            .send({ username: ADMIN_USER, password: ADMIN_PASS });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
    });

    it('users plugin token is accepted by users endpoints', async () => {
        const login = await request(app)
            .post('/api/v1/qcli/sessions')
            .send({ username: 'root', password: USERS_ROOT_PASS });
        const res = await request(app)
            .get('/api/v1/qcli/sessions/current')
            .set('Authorization', `Bearer ${login.body.token}`);
        expect(res.status).toBe(200);
        expect(res.body.user.name).toBe('root');
    });

    it('admin routes still require the admin token', async () => {
        for (const path of ['/status', '/plugins', '/config', '/logs', '/ws/clients']) {
            const res = await request(app).get(`/api/v1/qcli${path}`);
            expect(res.status, path).toBe(401);
        }
    });

    it('a users-plugin token does not unlock admin routes', async () => {
        const login = await request(app)
            .post('/api/v1/qcli/sessions')
            .send({ username: 'root', password: USERS_ROOT_PASS });
        const res = await request(app)
            .get('/api/v1/qcli/status')
            .set('Authorization', `Bearer ${login.body.token}`);
        expect(res.status).toBe(401);
    });
});
