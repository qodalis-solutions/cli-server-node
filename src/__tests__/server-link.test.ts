/**
 * Link requests: a terminal asks to be linked, a signed-in user approves it in a browser
 * (spec: web-cli docs/superpowers/specs/2026-11-12-server-linking-design.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, UsersPluginResult, InMemoryAuditStore } from '../../plugins/users/index';
import {
    LinkService,
    linkTokenName,
    linkVerificationUrl,
    normalizeUserCode,
    LINK_EXPIRES_IN_SECONDS,
} from '../../plugins/users/services/link-service';

const ROOT_PASS = 'rootpass1';
const V1 = '/api/v1/qcli';

describe('link helpers', () => {
    it('names tokens from the client name', () => {
        expect(linkTokenName('Qodalis CLI on Pixel 7')).toBe('link Qodalis CLI on Pixel 7');
        expect(linkTokenName('café/terminal')).toBe('link caf--terminal');
        expect(linkTokenName('x'.repeat(100))).toHaveLength(64);
        expect(linkTokenName('Pixel', 1)).toBe('link Pixel 2');
    });

    it('builds the verification URL', () => {
        expect(linkVerificationUrl('/qcli/admin/link', 'ABCD-2345')).toBe('/qcli/admin/link?code=ABCD-2345');
        expect(linkVerificationUrl('https://app.example.com/link/{code}', 'ABCD-2345')).toBe('https://app.example.com/link/ABCD-2345');
        expect(linkVerificationUrl('/approve?x=1', 'ABCD-2345')).toBe('/approve?x=1&code=ABCD-2345');
    });

    it('normalises codes', () => {
        expect(normalizeUserCode(' abcd-2345 ')).toBe('ABCD2345');
    });

    it('expires requests after 10 minutes', () => {
        let now = 1_000_000;
        const links = new LinkService({} as any, '/qcli/admin/link', () => now);
        const { linkId, userCode } = links.create({ client: 'term' });
        expect(links.poll(linkId)).toEqual({ status: 'pending' });
        now += LINK_EXPIRES_IN_SECONDS * 1000;
        expect(links.poll(linkId)).toBeUndefined();
        expect(() => links.view(userCode)).toThrow(/not found/);
    });
});

describe('link routes on a protected server', () => {
    let cli: CliServerResult;
    let users: UsersPluginResult;
    let server: http.Server;
    let app: express.Express;
    let audit: InMemoryAuditStore;
    let root: string;
    let ann: string;
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const login = async (name: string, password: string) => {
        const res = await request(app).post(`${V1}/sessions`).send({ username: name, password });
        expect(res.status).toBe(201);
        return res.body.token as string;
    };
    const create = (body: object = { client: 'Qodalis CLI on Pixel 7' }) =>
        request(app).post(`${V1}/link`).set('Origin', 'https://cli.qodalis.com').set('X-Forwarded-For', `10.0.0.${Math.floor(Math.random() * 250)}`).send(body);

    beforeAll(async () => {
        cli = createCliServer({});
        audit = new InMemoryAuditStore();
        users = new CliUsersBuilder()
            .setDefaultAdminPassword(ROOT_PASS)
            .setIpRateLimit(10_000)
            .setProtectServer(true)
            .setAuditStore(audit)
            .setOptions({ trustProxy: true })
            .build(() => {});
        await users.ready;
        cli.mountPlugin(users);
        app = cli.app;
        server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        root = await login('root', ROOT_PASS);
        await request(app).post(`${V1}/users`).set(bearer(root)).send({ name: 'ann', email: 'ann@x.io', password: 'annpass12' }).expect(201);
        ann = await login('ann', 'annpass12');
    });

    afterAll(async () => {
        cli?.eventSocketManager.dispose();
        cli?.logSocketManager.dispose();
        users?.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    });

    it('creates a request without signing in', async () => {
        const res = await create();
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ expiresIn: 600, interval: 2 });
        expect(res.body.linkId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(res.body.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
        expect(res.body.verificationUrl).toBe(`/qcli/admin/link?code=${res.body.userCode}`);
        expect((await request(app).get(`${V1}/link/${res.body.linkId}`)).body).toEqual({ status: 'pending' });
    });

    it('rejects invalid bodies', async () => {
        expect((await create({})).status).toBe(400);
        expect((await create({ client: 'x'.repeat(101) })).status).toBe(400);
        expect((await create({ client: 'a', permissions: [] })).status).toBe(400);
        expect((await create({ client: 'a', permissions: [1] })).status).toBe(400);
    });

    it('limits requests per client address', async () => {
        const send = () => request(app).post(`${V1}/link`).set('X-Forwarded-For', '192.0.2.7').send({ client: 'spam' });
        for (let i = 0; i < 10; i++) expect((await send()).status).toBe(201);
        expect((await send()).status).toBe(429);
    });

    it('approval flow: the page reads the request, approval hands the token out once', async () => {
        const { linkId, userCode } = (await create()).body;
        expect((await request(app).get(`${V1}/link/code/${userCode}`)).status).toBe(401);

        const view = await request(app).get(`${V1}/link/code/${userCode.toLowerCase().replace('-', '')}`).set(bearer(ann));
        expect(view.status).toBe(200);
        expect(view.body).toMatchObject({ userCode, client: 'Qodalis CLI on Pixel 7', origin: 'https://cli.qodalis.com', permissions: null });
        expect(view.body.remoteAddress).toMatch(/^10\.0\.0\./);

        const approved = await request(app).post(`${V1}/link/code/${userCode}/approve`).set(bearer(ann));
        expect(approved.status).toBe(200);
        expect(approved.body.tokenName).toBe('link Qodalis CLI on Pixel 7');

        const poll = await request(app).get(`${V1}/link/${linkId}`);
        expect(poll.body).toMatchObject({ status: 'approved', userName: 'ann' });
        expect(poll.body.token).toMatch(/^qcli_pat_/);
        expect(poll.headers['cache-control']).toBe('no-store');
        expect((await request(app).get(`${V1}/link/${linkId}`)).status).toBe(404);

        // The token works and is listed with ann's tokens
        expect((await request(app).get(`${V1}/commands`).set(bearer(poll.body.token))).status).toBe(200);
        const tokens = (await request(app).get(`${V1}/tokens`).set(bearer(ann))).body;
        expect(tokens.map((t: any) => t.name)).toContain('link Qodalis CLI on Pixel 7');

        // Single use
        expect((await request(app).post(`${V1}/link/code/${userCode}/approve`).set(bearer(ann))).status).toBe(404);
        const entries = await audit.getEntries();
        expect(entries.find((e) => e.event === 'link_approved')).toMatchObject({ username: 'ann', metadata: { client: 'Qodalis CLI on Pixel 7', origin: 'https://cli.qodalis.com' } });
    });

    it('a second terminal with the same name gets a numbered token', async () => {
        const { userCode } = (await create()).body;
        const approved = await request(app).post(`${V1}/link/code/${userCode}/approve`).set(bearer(ann));
        expect(approved.body.tokenName).toBe('link Qodalis CLI on Pixel 7 2');
    });

    it('denial: the terminal learns it once, no token is created', async () => {
        const { linkId, userCode } = (await create({ client: 'denied term' })).body;
        expect((await request(app).post(`${V1}/link/code/${userCode}/deny`).set(bearer(ann))).status).toBe(204);
        expect((await request(app).get(`${V1}/link/${linkId}`)).body).toEqual({ status: 'denied' });
        expect((await request(app).get(`${V1}/link/${linkId}`)).status).toBe(404);
        expect((await request(app).post(`${V1}/link/code/${userCode}/approve`).set(bearer(ann))).status).toBe(404);
        const tokens = (await request(app).get(`${V1}/tokens`).set(bearer(ann))).body;
        expect(tokens.map((t: any) => t.name)).not.toContain('link denied term');
        expect((await audit.getEntries()).some((e) => e.event === 'link_denied')).toBe(true);
    });

    it('scoped requests: the token carries the permissions, never more than the approver has', async () => {
        const scoped = (await create({ client: 'scoped', permissions: ['commands:execute'] })).body;
        expect((await request(app).get(`${V1}/link/code/${scoped.userCode}`).set(bearer(root))).body.permissions).toEqual(['commands:execute']);
        await request(app).post(`${V1}/link/code/${scoped.userCode}/approve`).set(bearer(root)).expect(200);
        const tokens = (await request(app).get(`${V1}/tokens`).set(bearer(root))).body;
        expect(tokens.find((t: any) => t.name === 'link scoped').permissions).toEqual(['commands:execute']);

        const tooMuch = (await create({ client: 'greedy', permissions: ['users:write'] })).body;
        const res = await request(app).post(`${V1}/link/code/${tooMuch.userCode}/approve`).set(bearer(ann));
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('users:write');
    });

    it('API tokens cannot approve', async () => {
        const first = (await create({ client: 'via token' })).body;
        await request(app).post(`${V1}/link/code/${first.userCode}/approve`).set(bearer(ann)).expect(200);
        const token = (await request(app).get(`${V1}/link/${first.linkId}`)).body.token;
        const second = (await create({ client: 'second' })).body;
        expect((await request(app).post(`${V1}/link/code/${second.userCode}/approve`).set(bearer(token))).status).toBe(403);
    });

    it('unknown codes and links', async () => {
        expect((await request(app).get(`${V1}/link/code/AAAA-AAAA`).set(bearer(ann))).status).toBe(404);
        expect((await request(app).get(`${V1}/link/nope`)).body).toEqual({ status: 'expired' });
    });
});

describe('custom approval page', () => {
    it('uses the host page', async () => {
        const cli = createCliServer({});
        const users = new CliUsersBuilder()
            .setDefaultAdminPassword(ROOT_PASS)
            .setLinkApprovalUrl('https://app.example.com/cli/link/{code}')
            .build(() => {});
        await users.ready;
        cli.mountPlugin(users);
        const res = await request(cli.app).post(`${V1}/link`).send({ client: 'x' });
        expect(res.body.verificationUrl).toBe(`https://app.example.com/cli/link/${res.body.userCode}`);
        users.dispose();
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
        expect(() => new CliUsersBuilder().setLinkApprovalUrl('javascript:alert(1)')).toThrow();
        expect(() => new CliUsersBuilder().setLinkApprovalUrl('//evil.example.com')).toThrow();
    });
});
