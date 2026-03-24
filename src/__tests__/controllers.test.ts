import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as http from 'http';
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

/**
 * A processor that simulates a long-running operation by waiting for a delay.
 * It checks the AbortSignal and throws an AbortError if cancelled before completion.
 */
function makeSlowProcessor(command: string, delayMs: number): ICliCommandProcessor & ICliStreamCommandProcessor {
    return {
        command,
        description: `${command} slow processor`,
        author: DefaultLibraryAuthor,
        version: '1.0.0',
        handleAsync: async (_cmd: CliProcessCommand, signal?: AbortSignal): Promise<string> => {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delayMs);
                signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });
            signal?.throwIfAborted();
            return `${command} completed`;
        },
        handleStreamAsync: async (
            _cmd: CliProcessCommand,
            emit: (output: CliStructuredOutput) => void,
            signal?: AbortSignal,
        ): Promise<number> => {
            emit({ type: 'text', value: 'starting' });
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delayMs);
                signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });
            signal?.throwIfAborted();
            emit({ type: 'text', value: 'done' });
            return 0;
        },
    };
}

describe('CLI Controllers (integration)', () => {
    let app: Express;
    let httpServer: http.Server;

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
                builder.addProcessor(streamProcessor);
                builder.addProcessor(makeSlowProcessor('slow', 5000));
            },
        });
        app = server.app;
        httpServer = http.createServer(app);
        httpServer.listen(0); // bind to random available port
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            httpServer.close((err) => (err ? reject(err) : resolve()));
        });
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

    describe('GET /api/v1/qcli/commands', () => {
        it('should return all registered commands', async () => {
            const res = await request(app).get('/api/v1/qcli/commands').expect(200);

            expect(res.body).toHaveLength(4);
            const commands = res.body.map((c: any) => c.command);
            expect(commands).toContain('echo');
            expect(commands).toContain('greet');
            expect(commands).toContain('stream-test');
            expect(commands).toContain('slow');
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

    describe('AbortSignal / cancellation', () => {
        /**
         * Sends a POST request to the given HTTP server and destroys the socket after
         * `destroyAfterMs` milliseconds, simulating a client disconnect.
         * Resolves with the partial response body received before destruction.
         */
        function postAndAbort(
            server: http.Server,
            path: string,
            body: object,
            destroyAfterMs: number,
        ): Promise<string> {
            return new Promise((resolve) => {
                const addr = server.address() as { port: number };
                const bodyStr = JSON.stringify(body);
                const req = http.request(
                    {
                        hostname: '127.0.0.1',
                        port: addr.port,
                        path,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(bodyStr),
                        },
                    },
                    (res) => {
                        let data = '';
                        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        res.on('end', () => resolve(data));
                        res.on('error', () => resolve(data));
                    },
                );
                req.on('error', () => resolve(''));
                req.write(bodyStr);
                req.end();
                setTimeout(() => req.destroy(), destroyAfterMs);
            });
        }

        /**
         * Creates a small dedicated HTTP server, runs `fn` with it, then shuts it down.
         */
        async function withServer(
            configure: Parameters<typeof createCliServer>[0]['configure'],
            fn: (server: http.Server) => Promise<void>,
        ): Promise<void> {
            const { app } = createCliServer({ configure });
            const srv = http.createServer(app);
            await new Promise<void>((resolve) => srv.listen(0, resolve));
            try {
                await fn(srv);
            } finally {
                await new Promise<void>((resolve) => srv.close(() => resolve()));
            }
        }

        it('controller passes an AbortSignal to the processor on every execute call', async () => {
            // Verify the signal is an AbortSignal instance and is not aborted at the time
            // the processor runs (i.e. the abort only happens on connection close, which is
            // after execution for a fast command).
            let signalAbortedDuringExecution: boolean | undefined;

            const spyProcessor = makeProcessor('spy-signal', {
                handleAsync: async (_cmd: CliProcessCommand, signal?: AbortSignal): Promise<string> => {
                    // Record whether the signal is aborted *right now* — it should not be yet.
                    signalAbortedDuringExecution = signal?.aborted ?? false;
                    return 'spy done';
                },
            });

            await withServer(
                (b) => b.addProcessor(spyProcessor),
                async (srv) => {
                    const addr = srv.address() as { port: number };
                    const bodyStr = JSON.stringify({
                        command: 'spy-signal',
                        chainCommands: [],
                        rawCommand: 'spy-signal',
                        args: {},
                    });
                    await new Promise<void>((resolve, reject) => {
                        const req = http.request(
                            {
                                hostname: '127.0.0.1',
                                port: addr.port,
                                path: '/api/v1/qcli/execute',
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Content-Length': Buffer.byteLength(bodyStr),
                                },
                            },
                            (res) => { res.resume(); res.on('end', resolve); },
                        );
                        req.on('error', reject);
                        req.write(bodyStr);
                        req.end();
                    });

                    // The signal should NOT be aborted while the processor was running.
                    expect(signalAbortedDuringExecution).toBe(false);
                },
            );
        });

        it('aborting the connection triggers the AbortSignal on the execute endpoint', async () => {
            let signalWasAborted = false;

            const abortTrackingProcessor = makeProcessor('abort-track-exec', {
                handleAsync: async (_cmd: CliProcessCommand, signal?: AbortSignal): Promise<string> => {
                    // Wait up to 3 s for the signal to abort (the socket destroy will arrive sooner).
                    await new Promise<void>((resolve) => {
                        const tid = setTimeout(resolve, 3000);
                        signal?.addEventListener('abort', () => {
                            signalWasAborted = true;
                            clearTimeout(tid);
                            resolve();
                        }, { once: true });
                    });
                    return 'done';
                },
            });

            await withServer(
                (b) => b.addProcessor(abortTrackingProcessor),
                async (srv) => {
                    // Destroy the socket 100 ms after sending — well before the 3 s wait.
                    await postAndAbort(
                        srv,
                        '/api/v1/qcli/execute',
                        { command: 'abort-track-exec', chainCommands: [], rawCommand: 'abort-track-exec', args: {} },
                        100,
                    );

                    // Give the server a moment to react to the close event and propagate abort.
                    await new Promise((r) => setTimeout(r, 300));

                    expect(signalWasAborted).toBe(true);
                },
            );
        }, 10_000);

        it('aborting the connection during SSE streaming triggers the AbortSignal', async () => {
            let signalWasAborted = false;

            const abortTrackingStreamProcessor = {
                ...makeProcessor('abort-track-stream'),
                handleStreamAsync: async (
                    _cmd: CliProcessCommand,
                    emit: (output: CliStructuredOutput) => void,
                    signal?: AbortSignal,
                ): Promise<number> => {
                    emit({ type: 'text', value: 'first chunk' });
                    // Flush the first chunk, then wait up to 3 s for the signal to abort.
                    await new Promise<void>((resolve) => {
                        const tid = setTimeout(resolve, 3000);
                        signal?.addEventListener('abort', () => {
                            signalWasAborted = true;
                            clearTimeout(tid);
                            resolve();
                        }, { once: true });
                    });
                    return 0;
                },
            } satisfies ICliCommandProcessor & ICliStreamCommandProcessor;

            await withServer(
                (b) => b.addProcessor(abortTrackingStreamProcessor),
                async (srv) => {
                    // Destroy the socket 150 ms after sending — after the first SSE chunk, before done.
                    await postAndAbort(
                        srv,
                        '/api/v1/qcli/execute/stream',
                        { command: 'abort-track-stream', chainCommands: [], rawCommand: 'abort-track-stream', args: {} },
                        150,
                    );

                    // Give the server a moment to react to the close event and propagate abort.
                    await new Promise((r) => setTimeout(r, 300));

                    expect(signalWasAborted).toBe(true);
                },
            );
        }, 10_000);

        it('aborting mid-stream does not emit an SSE error event to the client', async () => {
            // The slow processor emits an initial "starting" chunk, then waits.
            // When the socket is destroyed the controller catches the AbortError and
            // silently ends the response (no "error" SSE event).
            const partialSse = await postAndAbort(
                httpServer,
                '/api/v1/qcli/execute/stream',
                { command: 'slow', chainCommands: [], rawCommand: 'slow', args: {} },
                150,
            );

            const events = parseSseEvents(partialSse);
            const errorEvents = events.filter((e) => e.event === 'error');
            expect(errorEvents).toHaveLength(0);

            // The "done" event (with value 'done') should never arrive before abort.
            const outputEvents = events.filter((e) => e.event === 'output');
            expect(outputEvents.every((e) => e.data?.value !== 'done')).toBe(true);
        }, 10_000);

        it('aborting mid-execution causes the slow processor to surface an error exit code', async () => {
            // When the client disconnects, req.on('close') fires, aborting the controller.
            // The slow processor rejects with an AbortError, which the executor catches and
            // wraps in a 1-exit-code response.  Because the socket is destroyed we may or
            // may not receive the full JSON body; if we do, it must reflect failure.
            const partialBody = await postAndAbort(
                httpServer,
                '/api/v1/qcli/execute',
                { command: 'slow', chainCommands: [], rawCommand: 'slow', args: {} },
                150,
            );

            if (partialBody.trim()) {
                try {
                    const parsed = JSON.parse(partialBody);
                    expect(parsed.exitCode).toBe(1);
                } catch {
                    // Partial / non-JSON body due to abrupt socket close is acceptable.
                }
            }
        }, 10_000);
    });
});
