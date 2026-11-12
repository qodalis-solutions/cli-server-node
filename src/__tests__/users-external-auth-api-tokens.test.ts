/**
 * API tokens next to an external auth adapter (`allowApiTokens()`, mirrors the .NET
 * ExternalAuthApiTokensTests): the host signs users in, and the plugin's tokens
 * (created by those users or handed to a linked terminal) authenticate on their own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CliUsersBuilder, UsersPluginResult } from '../../plugins/users/index';

const V1 = '/api/v1/qcli';

const plugins: UsersPluginResult[] = [];

afterEach(() => {
    for (const p of plugins.splice(0)) p.dispose();
});

/** A host whose adapter signs in the store's user named in `X-User`. */
async function start(allowApiTokens: boolean): Promise<{ app: express.Express; plugin: UsersPluginResult }> {
    let plugin: UsersPluginResult | undefined;
    const builder = new CliUsersBuilder().setAuthAdapter(async (req) => {
        const name = req.headers['x-user'];
        const user = typeof name === 'string' && name ? await plugin!.userStore.getUser(name) : undefined;
        return user ? { user } : null;
    });
    if (allowApiTokens) builder.allowApiTokens();
    plugin = builder.build();
    plugins.push(plugin);
    await plugin.ready;
    const app = express();
    app.use(plugin.prefix, plugin.router);
    return { app, plugin };
}

async function addUser(plugin: UsersPluginResult, name: string): Promise<string> {
    const user = await plugin.userStore.createUser({ name, email: `${name}@external.com`, groups: ['users'] });
    return user.id;
}

/** A request signed in by the host (same origin: adapter auth needs it on writes). */
function asUser(app: express.Express, method: 'get' | 'post', path: string, user: string) {
    return request(app)[method](`${V1}/${path}`).set('X-User', user).set('Origin', 'http://localhost').set('Host', 'localhost');
}

const withToken = (app: express.Express, path: string, token: string) =>
    request(app).get(`${V1}/${path}`).set('Authorization', `Bearer ${token}`);

describe('API tokens with an external auth adapter', () => {
    it('a user signed in by the host creates a token that authenticates on its own', async () => {
        const { app, plugin } = await start(true);
        const userId = await addUser(plugin, 'ann');

        const created = await asUser(app, 'post', 'tokens', 'ann').send({ name: 'ci' });
        expect(created.status).toBe(201);
        const token: string = created.body.token;
        const listed = await withToken(app, 'tokens', token);

        expect(token.startsWith('qcli_pat_')).toBe(true);
        expect(listed.status).toBe(200);
        expect(listed.body.map((t: { name: string }) => t.name)).toEqual(['ci']);
        expect(created.body.apiToken.userId).toBe(userId);
        // A token never creates another one
        const again = await request(app).post(`${V1}/tokens`).set('Authorization', `Bearer ${token}`).send({ name: 'again' });
        expect(again.status).toBe(403);
    });

    it('a token stops working when the store disables its user', async () => {
        const { app, plugin } = await start(true);
        const userId = await addUser(plugin, 'bob');
        const token: string = (await asUser(app, 'post', 'tokens', 'bob').send({ name: 'ci' })).body.token;

        await plugin.userStore.updateUser(userId, { disabled: true });

        expect((await withToken(app, 'tokens', token)).status).toBe(401);
    });

    it('a user signed in by the host approves a link and the terminal uses its token', async () => {
        const { app, plugin } = await start(true);
        await addUser(plugin, 'cara');
        const created = await request(app).post(`${V1}/link`).send({ client: 'pwa' });
        expect(created.status).toBe(201);

        const approved = await asUser(app, 'post', `link/code/${created.body.userCode}/approve`, 'cara').send({});
        const collected = await request(app).get(`${V1}/link/${created.body.linkId}`);

        expect(approved.status).toBe(200);
        expect((await withToken(app, 'tokens', collected.body.token)).status).toBe(200);
    });

    it('without the option tokens stay off and bearer tokens go to the adapter', async () => {
        const { app, plugin } = await start(false);
        await addUser(plugin, 'dan');

        expect((await asUser(app, 'post', 'tokens', 'dan').send({ name: 'ci' })).status).toBe(501);
        expect((await withToken(app, 'tokens', 'qcli_pat_not-a-real-token')).status).toBe(401);
    });
});
