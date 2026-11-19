/**
 * The demo's public API wiring (`demo/src/public-api.ts`): portal, docs and the API on one server.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createCliServer } from '../create-cli-server';
import { CliUsersBuilder } from '../../plugins/users/index';
import { addPublicApi } from '../../demo/src/public-api';
import { ROOT_PASS, auth } from './users-test-helpers';

const disposables: Array<() => void> = [];

afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

describe('demo', () => {
    it('demo serves portal, docs and api', async () => {
        const cli = createCliServer();
        const users = new CliUsersBuilder().setOptions({ defaultAdminPassword: ROOT_PASS }).build();
        await users.ready;
        cli.mountPlugin(users);
        const { portal } = addPublicApi(cli, users);
        disposables.push(() => {
            users.dispose();
            cli.eventSocketManager.dispose();
            cli.logSocketManager.dispose();
        });

        const doc = (await request(cli.app).get('/qcli/api/openapi.json')).body;
        expect(Object.keys(doc.paths)).toContain('/v1/demo/time');
        const pages = (await request(cli.app).get('/qcli/docs/pages')).body as Array<{ slug: string }>;
        expect(pages.map((p) => p.slug)).toContain('index');

        // the site is served only when one is found (the sibling dashboard repo or the npm package)
        const json = await request(cli.app).get('/qcli/portal/portal.json');
        if (json.status === 200) {
            expect(json.body.docs).toEqual({ title: 'Guides', pages: '/qcli/docs/pages' });
            expect(json.body.api).toEqual({ title: 'API reference', openapi: '/qcli/api/openapi.json', swagger: '/qcli/api/swagger' });
        } else {
            expect(portal.publicRoutes).toEqual([]);
        }

        await users.groupStore.createGroup({ name: 'customers', permissions: ['demo:read'] });
        const alice = await users.userStore.createUser({ name: 'alice', email: 'alice@example.com', groups: ['customers'] });
        const { token } = await users.apiTokens.create(alice.id, { name: 'site', audience: 'host', permissions: ['demo:read'] });
        const time = await request(cli.app).get('/v1/demo/time').set(auth(token));
        expect(time.status).toBe(200);
        expect(typeof time.body.utc).toBe('string');
        expect(time.headers['x-ratelimit-limit']).toBe('1000');
    });
});
