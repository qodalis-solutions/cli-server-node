import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createCliServer } from '../create-cli-server';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { CliProcessCommand } from '../abstractions/cli-process-command';
import { Express } from 'express';

function makeProcessor(
    command: string,
    opts?: Partial<ICliCommandProcessor>,
): ICliCommandProcessor {
    return {
        command,
        description: `${command} processor`,
        author: DefaultLibraryAuthor,
        version: '1.0.0',
        handleAsync: async (_cmd: CliProcessCommand) => `${command} result`,
        ...opts,
    };
}

describe('CLI Controllers (integration)', () => {
    let app: Express;

    beforeAll(() => {
        const server = createCliServer({
            configure: (builder) => {
                builder.addProcessor(makeProcessor('echo', {
                    handleAsync: async (cmd) => cmd.value ?? 'echo!',
                }));
                builder.addProcessor(makeProcessor('greet', {
                    description: 'Greet someone',
                    handleAsync: async (cmd) => `Hello, ${cmd.value ?? 'world'}!`,
                }));
                builder.addProcessor(makeProcessor('v2cmd', {
                    description: 'A v2-only command',
                    apiVersion: 2,
                    handleAsync: async () => 'v2 only result',
                }));
            },
        });
        app = server.app;
    });

    describe('GET /api/qcli/version (discovery endpoint)', () => {
        it('should return supportedVersions, preferredVersion, and serverVersion', async () => {
            const res = await request(app).get('/api/qcli/version').expect(200);

            expect(res.body).toEqual({
                supportedVersions: [1, 2],
                preferredVersion: 2,
                serverVersion: '2.0.0',
            });
        });
    });

    describe('GET /api/v1/qcli/version', () => {
        it('should return v1 version info', async () => {
            const res = await request(app).get('/api/v1/qcli/version').expect(200);

            expect(res.body).toEqual({ version: '1.0.0' });
        });
    });

    describe('GET /api/v2/qcli/version', () => {
        it('should return v2 version info', async () => {
            const res = await request(app).get('/api/v2/qcli/version').expect(200);

            expect(res.body).toEqual({
                apiVersion: 2,
                serverVersion: '2.0.0',
            });
        });
    });

    describe('GET /api/v1/qcli/commands', () => {
        it('should return all registered commands', async () => {
            const res = await request(app).get('/api/v1/qcli/commands').expect(200);

            expect(res.body).toHaveLength(3);
            const commands = res.body.map((c: any) => c.command);
            expect(commands).toContain('echo');
            expect(commands).toContain('greet');
            expect(commands).toContain('v2cmd');
        });
    });

    describe('GET /api/v2/qcli/commands', () => {
        it('should return only apiVersion >= 2 commands', async () => {
            const res = await request(app).get('/api/v2/qcli/commands').expect(200);

            expect(res.body).toHaveLength(1);
            expect(res.body[0].command).toBe('v2cmd');
            expect(res.body[0].apiVersion).toBe(2);
        });
    });

    describe('POST /api/v1/qcli/execute', () => {
        it('should execute a known command and return success', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/execute')
                .send({
                    command: 'echo',
                    chainCommands: [],
                    rawCommand: 'echo hello',
                    value: 'hello',
                    args: {},
                })
                .expect(200);

            expect(res.body.exitCode).toBe(0);
            expect(res.body.outputs).toHaveLength(1);
            expect(res.body.outputs[0]).toEqual({ type: 'text', value: 'hello' });
        });

        it('should return error for unknown command', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/execute')
                .send({
                    command: 'doesnotexist',
                    chainCommands: [],
                    rawCommand: 'doesnotexist',
                    args: {},
                })
                .expect(200);

            expect(res.body.exitCode).toBe(1);
            expect(res.body.outputs[0]).toEqual({
                type: 'text',
                value: 'Unknown command: doesnotexist',
                style: 'error',
            });
        });
    });

    describe('POST /api/v2/qcli/execute', () => {
        it('should execute a command via v2 endpoint', async () => {
            const res = await request(app)
                .post('/api/v2/qcli/execute')
                .send({
                    command: 'greet',
                    chainCommands: [],
                    rawCommand: 'greet Claude',
                    value: 'Claude',
                    args: {},
                })
                .expect(200);

            expect(res.body.exitCode).toBe(0);
            expect(res.body.outputs[0]).toEqual({ type: 'text', value: 'Hello, Claude!' });
        });
    });
});
