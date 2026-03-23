import { Router } from 'express';
import { ICliCommandProcessor } from '../abstractions';
import { CliServerCommandDescriptor, CliServerCommandParameterDescriptorDto } from '../models';
import { ICliCommandRegistry, ICliCommandExecutorService } from '../services';
import { createLogger } from '../utils/logger';

const logger = createLogger('CliControllerV2');
const SERVER_VERSION = '2.0.0';

/**
 * Creates an Express router for the v2 CLI API, filtering processors with apiVersion >= 2.
 * @param registry - Command registry to list available processors.
 * @param executor - Service that dispatches commands to processors.
 * @returns Configured Express router.
 */
export function createCliControllerV2(
    registry: ICliCommandRegistry,
    executor: ICliCommandExecutorService,
): Router {
    const router = Router();

    router.get('/version', (_req, res) => {
        res.json({ apiVersion: 2, serverVersion: SERVER_VERSION });
    });

    router.get('/commands', (_req, res) => {
        const descriptors = registry.processors
            .filter((p) => (p.apiVersion ?? 1) >= 2)
            .map(mapToDescriptor);
        res.json(descriptors);
    });

    router.post('/execute', async (req, res) => {
        const command = req.body;
        logger.debug('Executing command (v2): %s', command.command);
        const response = await executor.executeAsync(command);
        res.json(response);
    });

    return router;
}

/** Maps an {@link ICliCommandProcessor} to its serializable DTO representation. */
function mapToDescriptor(processor: ICliCommandProcessor): CliServerCommandDescriptor {
    const descriptor: CliServerCommandDescriptor = {
        command: processor.command,
        description: processor.description,
        version: processor.version,
        apiVersion: processor.apiVersion ?? 1,
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
