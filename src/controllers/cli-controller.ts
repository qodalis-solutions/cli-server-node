import { Router } from 'express';
import { ICliCommandProcessor } from '../abstractions';
import { CliServerCommandDescriptor, CliServerCommandParameterDescriptorDto } from '../models';
import { ICliCommandRegistry, ICliCommandExecutorService } from '../services';

export function createCliController(
    registry: ICliCommandRegistry,
    executor: ICliCommandExecutorService,
): Router {
    const router = Router();

    router.get('/version', (_req, res) => {
        res.json({ version: '1.0.0' });
    });

    router.get('/commands', (_req, res) => {
        const descriptors = registry.processors.map(mapToDescriptor);
        res.json(descriptors);
    });

    router.post('/execute', async (req, res) => {
        const command = req.body;
        const response = await executor.executeAsync(command);
        res.json(response);
    });

    return router;
}

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
