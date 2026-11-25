/**
 * `config:changed` end to end: a WebSocket client on /ws/v1/qcli/events receives it after
 * PATCH /api/v1/qcli/config/{provider}/{section} (the admin plugin's API) and after the `config set` command, on an
 * open server and on a protected one (a signed-in admin; a user without config:read gets nothing).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliAdminBuilder } from '../../plugins/admin/index';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';
import { ROOT_PASS, runCommand } from './command-test-helpers';

const V1 = '/api/v1/qcli';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

interface Socket {
    ws: WebSocket;
    messages: any[];
    /** Resolves with the first message of `type` (already received or still to come); rejects after 3 s. */
    next(type: string): Promise<any>;
}

function connect(port: number, path: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const messages: any[] = [];
        const waiters: Array<{ type: string; resolve: (m: any) => void }> = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            messages.push(message);
            for (const w of waiters.filter((w) => w.type === message.type)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(message);
            }
        });
        const next = (type: string) =>
            new Promise<any>((res, rej) => {
                const found = messages.find((m) => m.type === type);
                if (found) return res(found);
                const timer = setTimeout(() => rej(new Error(`no ${type} within 3 s; got ${messages.map((m) => m.type).join(', ')}`)), 3000);
                waiters.push({ type, resolve: (m) => (clearTimeout(timer), res(m)) });
            });
        ws.on('open', () => resolve({ ws, messages, next }));
        ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
        ws.on('error', reject);
    });
}

/** A real HTTP server with the events socket attached and the admin plugin mounted, like the demo. */
async function start(protectWithUsers: boolean): Promise<{ cli: CliServerResult; port: number; users?: UsersPluginResult; adminToken: string }> {
    const cli = createCliServer();
    const users = protectWithUsers ? new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build() : undefined;
    if (users) await users.ready;
    const builder = new CliAdminBuilder().setCredentials('admin', 'adminpass').setJwtSecret('secret');
    if (users) builder.setAuthProvider(users.serverAuth);
    const admin = builder.build({ registry: cli.registry, eventSocketManager: cli.eventSocketManager, builder: cli.builder, executor: cli.executor, eventBus: cli.eventBus });
    admin.logBuffer.restoreConsole();
    cli.mountPlugin(admin);
    if (users) cli.mountPlugin(users);
    const server = http.createServer(cli.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cli.eventSocketManager.attach(server);
    cleanups.push(async () => {
        admin.dispose();
        users?.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    });
    const login = users
        ? await request(cli.app).post(`${V1}/sessions`).send({ username: 'root', password: ROOT_PASS })
        : await request(cli.app).post(`${V1}/auth/login`).send({ username: 'admin', password: 'adminpass' });
    return { cli, port: (server.address() as AddressInfo).port, users, adminToken: login.body.token };
}

async function patchCors(cli: CliServerResult, token: string, origins: string[]) {
    const current = await request(cli.app).get(`${V1}/config/cors`).set('Authorization', `Bearer ${token}`).expect(200);
    const version = current.body.sections[0].version;
    return request(cli.app)
        .patch(`${V1}/config/cors/cors`)
        .set('Authorization', `Bearer ${token}`)
        .send({ changes: { allowedOrigins: origins }, version })
        .expect(200);
}

describe('config:changed on the events socket', () => {
    it('open server: delivered after PATCH and after config set', async () => {
        const { cli, port, adminToken } = await start(false);
        const socket = await connect(port, '/ws/v1/qcli/events');
        cleanups.push(() => socket.ws.close());

        await patchCors(cli, adminToken, ['https://a.example']);
        const first = await socket.next('config:changed');
        expect(first).toMatchObject({ type: 'config:changed', provider: 'cors', section: 'cors', keys: ['allowedOrigins'], version: '1' });
        socket.messages.length = 0;

        expect((await runCommand(cli, 'config set cors.cors.allowedOrigins https://b.example')).text).toContain('Updated cors.cors.allowedOrigins');
        expect(await socket.next('config:changed')).toMatchObject({ provider: 'cors', keys: ['allowedOrigins'], version: '2' });
    });

    it('the unversioned path /ws/qcli/events gets it too', async () => {
        const { cli, port } = await start(false);
        const socket = await connect(port, '/ws/qcli/events');
        cleanups.push(() => socket.ws.close());
        await runCommand(cli, 'config set cors.cors.allowedOrigins https://c.example');
        expect(await socket.next('config:changed')).toMatchObject({ provider: 'cors' });
    });

    it('protected server: the signed-in admin gets it after PATCH and config set; a user without config:read does not', async () => {
        const { cli, port, users, adminToken } = await start(true);
        const ticket = async (token: string) => (await request(cli.app).post(`${V1}/sessions/ws-ticket`).set('Authorization', `Bearer ${token}`).expect(201)).body.ticket;
        await users!.userStore.createUser({ name: 'plain', email: 'plain@x.io', groups: ['users'] });
        await users!.authService.setPassword((await users!.userStore.getUser('plain'))!.id, 'plainpass');
        const plainToken = (await request(cli.app).post(`${V1}/sessions`).send({ username: 'plain', password: 'plainpass' })).body.token;

        const adminSocket = await connect(port, `/ws/v1/qcli/events?ticket=${await ticket(adminToken)}`);
        const plainSocket = await connect(port, `/ws/v1/qcli/events?ticket=${await ticket(plainToken)}`);
        cleanups.push(() => adminSocket.ws.close(), () => plainSocket.ws.close());

        await patchCors(cli, adminToken, ['https://a.example']);
        expect(await adminSocket.next('config:changed')).toMatchObject({ provider: 'cors', keys: ['allowedOrigins'], user: 'root' });
        adminSocket.messages.length = 0;

        expect((await runCommand(cli, 'config set cors.cors.allowedOrigins https://b.example', adminToken)).text).toContain('Updated');
        expect(await adminSocket.next('config:changed')).toMatchObject({ provider: 'cors', version: '2', user: 'root' });
        expect(plainSocket.messages.filter((m) => m.type === 'config:changed')).toEqual([]);
    });
});
