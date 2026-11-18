/**
 * getCliCaller(): host code run by an authenticated CLI request (a host processor's services) reads the caller
 * the auth provider established, for API tokens and sessions alike.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createCliServer } from '../create-cli-server';
import { CliCommandProcessor, CliProcessCommand } from '../abstractions';
import { getCliCaller } from '../auth/cli-caller';
import { CliUsersBuilder } from '../../plugins/users/index';
import { BASE, ROOT_PASS, auth, login } from './users-test-helpers';

/** A host command that reports who getCliCaller() says is running it. */
class WhoAmIProcessor extends CliCommandProcessor {
    command = 'whoami-host';
    description = 'Reports getCliCaller()';

    async handleAsync(_command: CliProcessCommand): Promise<string> {
        // Read after an await, as a host service would
        await new Promise((r) => setTimeout(r, 1));
        const caller = getCliCaller();
        return `user:${caller?.userId ?? 'anonymous'}|method:${caller ? (caller.tokenId ? 'token' : 'session') : 'none'}`;
    }
}

async function startServer() {
    const cli = createCliServer({ configure: (b) => b.addProcessor(new WhoAmIProcessor()) });
    const users = new CliUsersBuilder()
        .setDefaultAdminPassword(ROOT_PASS)
        .setIpRateLimit(10_000)
        .setMinPasswordLength(4)
        .build((msg) => cli.eventSocketManager.broadcastMessage(msg));
    await users.ready;
    cli.mountPlugin(users);
    return cli.app;
}

const exec = (command: string) => ({ command, value: '', args: {}, chainCommands: [] });

function outputOf(body: any): string {
    return JSON.stringify(body);
}

describe('getCliCaller', () => {
    it('gives a host command the API token user', async () => {
        const app = await startServer();
        const root = await login(app as any, 'root', ROOT_PASS);
        const created = await request(app).post(`${BASE}/tokens`).set(auth(root.token)).send({ name: 'terminal' });
        expect(created.status).toBe(201);

        const res = await request(app).post(`${BASE}/execute`).set(auth(created.body.token)).send(exec('whoami-host'));

        expect(res.status).toBe(200);
        expect(outputOf(res.body)).toContain(`user:${root.userId}|method:token`);
    });

    it('gives a host command the session user', async () => {
        const app = await startServer();
        const root = await login(app as any, 'root', ROOT_PASS);

        const res = await request(app).post(`${BASE}/execute`).set(auth(root.token)).send(exec('whoami-host'));

        expect(outputOf(res.body)).toContain(`user:${root.userId}|method:session`);
    });

    it('is undefined outside a CLI request', () => {
        expect(getCliCaller()).toBeUndefined();
    });
});
