/**
 * Route permissions a plugin declares (`MountablePlugin.routePermissions`): a protected server requires `read` for
 * GET/HEAD and `write` for other methods under the path; mountPlugin validates them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Router } from 'express';
import request from 'supertest';
import { requiredServerPermissions } from '../auth/cli-server-auth-gate';
import { createCliServer } from '../create-cli-server';
import { CliUsersBuilder } from '../../plugins/users/index';

const options = (routePermissions: { path: string; read: string; write?: string }[]) =>
    ({ registry: {}, cliPrefixes: ['/api/v1/qcli'], publicRoutes: new Set(), routePermissions }) as never;

const disposables: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
});

describe('route permissions', () => {
    it('reads for GET and HEAD, writes for the rest, the longest path first', () => {
        const opts = options([
            { path: '/api/v1/qcli/migrations', read: 'migrations:read', write: 'migrations:run' },
            { path: '/api/v1/qcli/migrations/secret', read: 'secret:read' },
        ]);
        expect(requiredServerPermissions('GET', '/api/v1/qcli/migrations', undefined, opts)).toEqual(['migrations:read']);
        expect(requiredServerPermissions('HEAD', '/api/v1/qcli/migrations/main', undefined, opts)).toEqual(['migrations:read']);
        expect(requiredServerPermissions('POST', '/api/v1/qcli/migrations/main/up', undefined, opts)).toEqual(['migrations:run']);
        expect(requiredServerPermissions('POST', '/api/v1/qcli/migrations/secret/x', undefined, opts)).toEqual(['secret:read']);
        expect(requiredServerPermissions('GET', '/api/v1/qcli/migrationsx', undefined, opts)).toEqual([]);
    });

    it('refuses a path outside the plugin or without a permission', () => {
        const cli = createCliServer();
        disposables.push(() => {
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        const mount = (routePermissions: never) => cli.mountPlugin({ prefix: '/api/v1/qcli/migrations', router: Router(), routePermissions });
        expect(() => mount([{ path: '/api/v1/qcli/jobs', read: 'x:read' }] as never)).toThrow('invalid route permission: /api/v1/qcli/jobs');
        expect(() => mount([{ path: '/api/v1/qcli/migrations', read: '' }] as never)).toThrow('invalid route permission');
    });

    it('a protected server answers 403 without the permission and lets the holder through', async () => {
        const cli = createCliServer();
        const users = new CliUsersBuilder().setOptions({ defaultAdminPassword: 'root-pass-123' }).build(cli.eventBus);
        await users.ready;
        cli.mountPlugin(users);
        const router = Router();
        router.get('/', (_req, res) => res.json({ ok: true }));
        router.post('/run', (_req, res) => res.json({ ran: true }));
        cli.mountPlugin({
            prefix: '/api/v1/qcli/migrations',
            router,
            routePermissions: [{ path: '/api/v1/qcli/migrations', read: 'migrations:read', write: 'migrations:run' }],
        });
        disposables.push(() => {
            users.dispose();
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });
        const root = (await request(cli.app).post('/api/v1/qcli/sessions').send({ username: 'root', password: 'root-pass-123' })).body.token;
        expect((await request(cli.app).get('/api/v1/qcli/migrations')).status).toBe(401);
        expect((await request(cli.app).get('/api/v1/qcli/migrations').set('Authorization', `Bearer ${root}`)).body).toEqual({ ok: true });

        // a reader without migrations:run
        await users.groupStore.createGroup({ name: 'readers', permissions: ['migrations:read'] });
        await users.userStore.createUser({ name: 'reader', email: 'r@example.com', groups: ['readers'] });
        const reader = await users.userStore.getUser('reader');
        await users.authService.setPassword(reader!.id, 'reader-pass-123');
        const token = (await request(cli.app).post('/api/v1/qcli/sessions').send({ username: 'reader', password: 'reader-pass-123' })).body.token;
        expect((await request(cli.app).get('/api/v1/qcli/migrations').set('Authorization', `Bearer ${token}`)).status).toBe(200);
        expect((await request(cli.app).post('/api/v1/qcli/migrations/run').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    });
});
