/**
 * Admin dashboard sign-in through the host application's session
 * (mirrors qodalis-solutions/cli-server-dotnet#29): `GET /api/v1/qcli/auth/mode`,
 * the `signInUrl` option and `POST /auth/login` in external mode.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliJobsBuilder } from '@qodalis/cli-server-plugin-jobs';
import { InMemoryFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { AuthAdapter, CliUsersBuilder, UsersPluginResult, User } from '../../plugins/users/index';
import { AdminConfig, CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';

const V1 = '/api/v1/qcli';
const ADMIN_USER = 'dashadmin';
const ADMIN_PASS = 'dashpass';
const ROOT_PASS = 'rootpass1';
const HOST_USER_HEADER = 'X-Host-User';

const hostUser = (id: string): User => ({ id, name: id, email: `${id}@host.io`, groups: [], createdAt: 0, updatedAt: 0 });

/** The host app's session: `X-Host-User: alice` is an admin, `bob` a plain user. */
const adapter: AuthAdapter = (req) => {
    const id = req.headers[HOST_USER_HEADER.toLowerCase()];
    if (id === 'alice') return { user: hostUser('alice'), isAdmin: true };
    if (id === 'bob') return { user: hostUser('bob') };
    return null;
};

interface Host {
    cli: CliServerResult;
    users?: UsersPluginResult;
    admin: CliAdminPluginResult;
}

const hosts: Host[] = [];
afterEach(() => {
    for (const h of hosts.splice(0)) {
        h.admin.dispose();
        h.users?.dispose();
        h.cli.eventSocketManager.dispose();
        h.cli.logSocketManager.dispose();
    }
});

type Users = 'none' | 'passwords' | 'external';

async function start(users: Users, signInUrl?: string, configure?: (cli: CliServerResult) => void): Promise<Host> {
    const cli = createCliServer();
    configure?.(cli);
    let usersPlugin: UsersPluginResult | undefined;
    if (users !== 'none') {
        const b = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000);
        if (users === 'external') b.setAuthAdapter(adapter);
        usersPlugin = b.build((m) => cli.eventSocketManager.broadcastMessage(m));
        await usersPlugin.ready;
    }
    const builder = new CliAdminBuilder().setCredentials(ADMIN_USER, ADMIN_PASS).setJwtSecret('test-secret').setSignInUrl(signInUrl);
    if (usersPlugin) builder.setAuthProvider(usersPlugin.serverAuth);
    const admin = builder.build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} });
    admin.logBuffer.restoreConsole();
    // Same order as the demo: admin first, then users
    cli.mountPlugin(admin);
    if (usersPlugin) cli.mountPlugin(usersPlugin);
    const h = { cli, users: usersPlugin, admin };
    hosts.push(h);
    return h;
}

const login = (h: Host, username: string, password: string) =>
    request(h.cli.app).post(`${V1}/auth/login`).send({ username, password });

describe('GET /api/v1/qcli/auth/mode', () => {
    it('is "password" without the users plugin', async () => {
        const h = await start('none');
        const res = await request(h.cli.app).get(`${V1}/auth/mode`);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual({ mode: 'password', signInUrl: null });
    });

    it('is "password" with the users plugin on passwords, and public on a protected server', async () => {
        const h = await start('passwords', '/sign-in');
        expect(h.cli.serverOptions.externalAuthentication).toBe(false);
        // Other admin routes need a session on this protected server
        expect((await request(h.cli.app).get(`${V1}/status`)).status).toBe(401);
        const res = await request(h.cli.app).get(`${V1}/auth/mode`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ mode: 'password', signInUrl: '/sign-in' });
    });

    it('is "external" with an external auth adapter, with the signInUrl', async () => {
        const h = await start('external', 'https://app.example.com/sign-in');
        expect(h.cli.serverOptions.externalAuthentication).toBe(true);
        const res = await request(h.cli.app).get(`${V1}/auth/mode`);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual({ mode: 'external', signInUrl: 'https://app.example.com/sign-in' });
    });

    it('returns signInUrl null in external mode without one', async () => {
        const h = await start('external');
        expect((await request(h.cli.app).get(`${V1}/auth/mode`)).body).toEqual({ mode: 'external', signInUrl: null });
    });

    it('follows the installed auth provider (setAuth)', async () => {
        const h = await start('external');
        h.cli.setAuth(undefined);
        expect((await request(h.cli.app).get(`${V1}/auth/mode`)).body.mode).toBe('password');
        h.cli.setAuth(h.users!.serverAuth);
        expect((await request(h.cli.app).get(`${V1}/auth/mode`)).body.mode).toBe('external');
    });
});

describe('POST /api/v1/qcli/auth/login in external mode', () => {
    it('answers 501 EXTERNAL_AUTH and never accepts the static credentials', async () => {
        const h = await start('external', 'https://app.example.com/sign-in');
        const res = await login(h, ADMIN_USER, ADMIN_PASS);
        expect(res.status).toBe(501);
        expect(res.body.token).toBeUndefined();
        expect(res.body).toEqual({
            error: 'Sign-in is managed by the host application. Sign in at https://app.example.com/sign-in.',
            code: 'EXTERNAL_AUTH',
            signInUrl: 'https://app.example.com/sign-in',
        });
    });

    it('points to the host application without a signInUrl', async () => {
        const h = await start('external');
        const res = await login(h, ADMIN_USER, ADMIN_PASS);
        expect(res.status).toBe(501);
        expect(res.body).toEqual({
            error: 'Sign-in is managed by the host application. Sign in through the host application.',
            code: 'EXTERNAL_AUTH',
            signInUrl: null,
        });
    });

    it('the host session reaches the admin routes (admin:access required)', async () => {
        const h = await start('external');
        expect((await request(h.cli.app).get(`${V1}/auth/me`)).status).toBe(401);

        const me = await request(h.cli.app).get(`${V1}/auth/me`).set(HOST_USER_HEADER, 'alice');
        expect(me.status).toBe(200);
        expect(me.body.username).toBe('alice');
        expect((await request(h.cli.app).get(`${V1}/status`).set(HOST_USER_HEADER, 'alice')).status).toBe(200);

        const bob = await request(h.cli.app).get(`${V1}/auth/me`).set(HOST_USER_HEADER, 'bob');
        expect(bob.status).toBe(403);
    });
});

describe('password mode', () => {
    it('still signs in through the users plugin and the static credentials', async () => {
        const users = await start('passwords');
        const res = await login(users, 'root', ROOT_PASS);
        expect(res.status).toBe(200);
        expect(typeof res.body.token).toBe('string');

        const standalone = await start('none');
        const res2 = await login(standalone, ADMIN_USER, ADMIN_PASS);
        expect(res2.status).toBe(200);
        expect(typeof res2.body.token).toBe('string');
    });
});

describe('signInUrl', () => {
    for (const url of ['https://app.example.com/sign-in', 'http://localhost:5000/login?next=%2Fadmin', '/sign-in', '/']) {
        it(`accepts ${JSON.stringify(url)}`, () => expect(AdminConfig.isValidSignInUrl(url)).toBe(true));
    }

    for (const url of [
        '',
        ' ',
        'sign-in',
        '//evil.example.com/sign-in',
        '/\\evil.example.com',
        'javascript:alert(1)',
        'ftp://example.com/sign-in',
        'https://',
        'https://app.example.com/sign in',
        '/sign-in\n',
    ]) {
        it(`rejects ${JSON.stringify(url)}`, () => expect(AdminConfig.isValidSignInUrl(url)).toBe(false));
    }

    it('an invalid one fails at startup (build)', () => {
        const cli = createCliServer();
        const builder = new CliAdminBuilder().setSignInUrl('javascript:alert(1)');
        expect(() =>
            builder.build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, broadcastFn: () => {} }),
        ).toThrow(/signInUrl/);
    });

    it('undefined is allowed', async () => {
        const h = await start('none');
        expect((await request(h.cli.app).get(`${V1}/auth/mode`)).body.signInUrl).toBeNull();
    });
});

describe('status.enabledFeatures', () => {
    it('reports "jobs" once the jobs plugin is mounted and "filesystem" when configured', async () => {
        const h = await start('none', undefined, (cli) => cli.builder.setFileStorageProvider(new InMemoryFileStorageProvider()));
        h.cli.mountPlugin(new CliJobsBuilder().build());
        const token = (await login(h, ADMIN_USER, ADMIN_PASS)).body.token;
        const res = await request(h.cli.app).get(`${V1}/status`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.enabledFeatures).toEqual(expect.arrayContaining(['filesystem', 'jobs']));
    });
});
