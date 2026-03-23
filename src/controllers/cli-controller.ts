import { Router } from 'express';
import * as os from 'os';
import { CliStructuredOutput, ICliCommandProcessor, isStreamCapable } from '../abstractions';
import { CliServerCommandDescriptor, CliServerCommandParameterDescriptorDto } from '../models';
import { ICliCommandRegistry, ICliCommandExecutorService } from '../services';
import { createLogger } from '../utils/logger';

const logger = createLogger('CliController');
const SERVER_VERSION = '1.0.0';

/**
 * Creates an Express router for the v1 CLI API with version, capabilities, commands, and execute endpoints.
 * @param registry - Command registry to list available processors.
 * @param executor - Service that dispatches commands to processors.
 * @returns Configured Express router.
 */
export function createCliController(
    registry: ICliCommandRegistry,
    executor: ICliCommandExecutorService,
): Router {
    const router = Router();

    router.get('/version', (_req, res) => {
        res.json({ version: SERVER_VERSION });
    });

    router.get('/capabilities', (_req, res) => {
        const detectedOs = os.platform() === 'win32'
            ? 'win32'
            : os.platform() === 'darwin'
                ? 'darwin'
                : 'linux';

        const shell = os.platform() === 'win32' ? 'powershell' : 'bash';
        const shellPath = os.platform() === 'win32'
            ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
            : '/bin/bash';

        res.json({
            shell: true,
            os: detectedOs,
            shellPath,
            version: SERVER_VERSION,
            streaming: true,
        });
    });

    router.get('/commands', (_req, res) => {
        const descriptors = registry.processors.map(mapToDescriptor);
        res.json(descriptors);
    });

    router.post('/execute', async (req, res) => {
        const command = req.body;
        logger.debug('Executing command: %s', command.command);

        const abortController = new AbortController();
        req.on('close', () => abortController.abort());

        const response = await executor.executeAsync(command, abortController.signal);
        res.json(response);
    });

    router.post('/execute/stream', async (req, res) => {
        const command = req.body;
        logger.debug('Stream executing command: %s', command.command);

        const abortController = new AbortController();
        req.on('close', () => abortController.abort());
        const signal = abortController.signal;

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const emit = (output: CliStructuredOutput) => {
            res.write(`event: output\ndata: ${JSON.stringify(output)}\n\n`);
        };

        try {
            const processor = registry.findProcessor(
                command.command,
                command.chainCommands?.length ? command.chainCommands : undefined,
            );

            if (!processor) {
                res.write(`event: error\ndata: ${JSON.stringify({ message: `Unknown command: ${command.command}` })}\n\n`);
                res.end();
                return;
            }

            if (executor.isBlocked(processor)) {
                res.write(`event: error\ndata: ${JSON.stringify({ message: `Command '${command.command}' is currently disabled.` })}\n\n`);
                res.end();
                return;
            }

            let exitCode: number;

            if (isStreamCapable(processor)) {
                exitCode = await processor.handleStreamAsync(command, emit, signal);
            } else if (processor.handleStructuredAsync) {
                const response = await processor.handleStructuredAsync(command, signal);
                for (const output of response.outputs) {
                    emit(output);
                }
                exitCode = response.exitCode;
            } else {
                const result = await processor.handleAsync(command, signal);
                emit({ type: 'text', value: result });
                exitCode = 0;
            }

            res.write(`event: done\ndata: ${JSON.stringify({ exitCode })}\n\n`);
        } catch (err: any) {
            if (signal.aborted) {
                logger.debug('Stream cancelled for command: %s', command.command);
            } else {
                logger.error('Stream execution failed: %s - %s', command.command, err.message ?? err);
                res.write(`event: error\ndata: ${JSON.stringify({ message: `Error executing command: ${err.message ?? err}` })}\n\n`);
            }
        }

        res.end();
    });

    return router;
}

/** Maps an {@link ICliCommandProcessor} to its serializable DTO representation. */
function mapToDescriptor(processor: ICliCommandProcessor): CliServerCommandDescriptor {
    const descriptor: CliServerCommandDescriptor = {
        command: processor.command,
        description: processor.description,
        version: processor.version,
    };

    if (processor.parameters?.length) {
        descriptor.parameters = processor.parameters.map(
            (p): CliServerCommandParameterDescriptorDto => ({
                name: p.name,
                aliases: p.aliases,
                description: p.description,
                required: p.required,
                type: p.type,
                defaultValue: p.defaultValue,
            }),
        );
    }

    if (processor.processors?.length) {
        descriptor.processors = processor.processors.map(mapToDescriptor);
    }

    return descriptor;
}
