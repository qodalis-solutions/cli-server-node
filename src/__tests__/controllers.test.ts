import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createCliServer } from '../create-cli-server';
import { ICliCommandProcessor, ICliStreamCommandProcessor } from '../abstractions';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { CliProcessCommand } from '../abstractions/cli-process-command';
import { CliStructuredOutput } from '../abstractions';
import { Express } from 'express';

function parseSseEvents(text: string): Array<{ event: string; data: any }> {
    return text
        .split('\n\n')
        .filter((block) => block.trim())
        .map((block) => {
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
                if (line.startsWith('event: ')) event = line.slice(7);
                else if (line.startsWith('data: ')) data = line.slice(6);
            }
            return { event, data: data ? JSON.parse(data) : null };
        });
}

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
        const streamProcessor = {
            ...makeProcessor('stream-test'),
            handleStreamAsync: async (_cmd: CliProcessCommand, emit: (output: CliStructuredOutput) => void) => {
                emit({ type: 'text', value: 'chunk1' });
                emit({ type: 'text', value: 'chunk2' });
                emit({ type: 'text', value: 'chunk3' });
                return 0;
            },
        } satisfies ICliCommandProcessor & ICliStreamCommandProcessor;

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
                builder.addProcessor(streamProcessor);
            },
        });
        app = server.app;
    });

    describe('GET /api/qcli/versions (discovery endpoint)', () => {
        it('should return supportedVersions, preferredVersion, and serverVersion', async () => {
            const res = await request(app).get('/api/qcli/versions').expect(200);

            expect(res.body).toEqual({
                supportedVersions: [1],
                preferredVersion: 1,
                serverVersion: '2.0.0',
            });
        });

        it('should redirect /version to /versions', async () => {
            await request(app).get('/api/qcli/version').expect(301);
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

            expect(res.body).toHaveLength(4);
            const commands = res.body.map((c: any) => c.command);
            expect(commands).toContain('echo');
            expect(commands).toContain('greet');
            expect(commands).toContain('v2cmd');
            expect(commands).toContain('stream-test');
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

    describe('POST /api/v1/qcli/execute/stream (SSE)', () => {
        it('known command returns SSE output + done events', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/execute/stream')
                .send({
                    command: 'echo',
                    chainCommands: [],
                    rawCommand: 'echo hello world',
                    value: 'hello world',
                    args: {},
                })
                .expect(200);

            expect(res.headers['content-type']).toMatch(/text\/event-stream/);

            const events = parseSseEvents(res.text);

            const outputEvents = events.filter((e) => e.event === 'output');
            expect(outputEvents.length).toBeGreaterThanOrEqual(1);
            expect(outputEvents.some((e) => e.data?.value === 'hello world')).toBe(true);

            const doneEvents = events.filter((e) => e.event === 'done');
            expect(doneEvents.length).toBe(1);
            expect(doneEvents[0].data.exitCode).toBe(0);
        });

        it('unknown command returns SSE error event', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/execute/stream')
                .send({
                    command: 'nonexistent',
                    chainCommands: [],
                    rawCommand: 'nonexistent',
                    args: {},
                })
                .expect(200);

            expect(res.headers['content-type']).toMatch(/text\/event-stream/);

            const events = parseSseEvents(res.text);

            const errorEvents = events.filter((e) => e.event === 'error');
            expect(errorEvents.length).toBeGreaterThanOrEqual(1);
            expect(errorEvents.some((e) => e.data?.message?.includes('Unknown command'))).toBe(true);
        });

        it('streaming-capable processor emits incremental output', async () => {
            const res = await request(app)
                .post('/api/v1/qcli/execute/stream')
                .send({
                    command: 'stream-test',
                    chainCommands: [],
                    rawCommand: 'stream-test',
                    args: {},
                })
                .expect(200);

            expect(res.headers['content-type']).toMatch(/text\/event-stream/);

            const events = parseSseEvents(res.text);

            const outputEvents = events.filter((e) => e.event === 'output');
            expect(outputEvents).toHaveLength(3);
            expect(outputEvents[0].data).toEqual({ type: 'text', value: 'chunk1' });
            expect(outputEvents[1].data).toEqual({ type: 'text', value: 'chunk2' });
            expect(outputEvents[2].data).toEqual({ type: 'text', value: 'chunk3' });

            const doneEvents = events.filter((e) => e.event === 'done');
            expect(doneEvents).toHaveLength(1);
            expect(doneEvents[0].data.exitCode).toBe(0);
        });
    });
});
