import express from 'express';
import request from 'supertest';
import { vi } from 'vitest';
import { CliUsersBuilder, UsersModuleOptions, UsersPluginResult } from '../../plugins/users/index';

export const BASE = '/api/v1/qcli';
export const ROOT_PASS = 'admin123';

export interface TestServer {
    app: express.Express;
    plugin: UsersPluginResult;
    broadcast: ReturnType<typeof vi.fn>;
}

export async function createTestServer(options: UsersModuleOptions = {}): Promise<TestServer> {
    const broadcast = vi.fn();
    const plugin = new CliUsersBuilder()
        // Short test passwords and many logins per test: relax the policy and
        // the per-IP limiter here; dedicated tests cover the defaults.
        .setOptions({ defaultAdminPassword: ROOT_PASS, minPasswordLength: 4, ipRateLimit: 10_000, ...options })
        .build(broadcast);
    await plugin.ready;
    const app = express();
    app.use(express.json());
    app.use(plugin.prefix, plugin.router);
    return { app, plugin, broadcast };
}

export async function login(app: express.Express, username: string, password: string): Promise<{ token: string; sessionId: string; userId: string }> {
    const res = await request(app).post(`${BASE}/sessions`).send({ username, password });
    if (res.status !== 201) {
        throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return { token: res.body.token, sessionId: res.body.session.id, userId: res.body.session.user.id };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Creates a user via the API (as `adminToken`) and returns its id. */
export async function createUser(
    app: express.Express,
    adminToken: string,
    body: Record<string, unknown>,
): Promise<string> {
    const res = await request(app).post(`${BASE}/users`).set(auth(adminToken)).send(body);
    if (res.status !== 201) {
        throw new Error(`create user failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.id;
}

export async function createGroup(
    app: express.Express,
    adminToken: string,
    body: Record<string, unknown>,
): Promise<void> {
    const res = await request(app).post(`${BASE}/groups`).set(auth(adminToken)).send(body);
    if (res.status !== 201) {
        throw new Error(`create group failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
}
