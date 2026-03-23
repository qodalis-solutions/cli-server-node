import { CliProcessCommand, ICliProcessorFilter } from '../abstractions';
import { CliServerResponse } from '../models';
import { ICliCommandRegistry } from './cli-command-registry';
import { createLogger } from '../utils/logger';

const logger = createLogger('CommandExecutor');

/** Service contract for executing parsed CLI commands. */
export interface ICliCommandExecutorService {
    /**
     * Executes a parsed command by routing it to the appropriate processor.
     * @param command - Parsed command to execute.
     * @returns Structured response with exit code and outputs.
     */
    executeAsync(command: CliProcessCommand): Promise<CliServerResponse>;

    /**
     * Adds a processor filter that can block command execution at runtime.
     * @param filter - The filter to add.
     */
    addFilter(filter: ICliProcessorFilter): void;
}

/** Default executor that resolves processors from the registry and delegates command handling. */
export class CliCommandExecutorService implements ICliCommandExecutorService {
    private readonly _filters: ICliProcessorFilter[] = [];

    constructor(private readonly _registry: ICliCommandRegistry) {}

    addFilter(filter: ICliProcessorFilter): void {
        this._filters.push(filter);
    }

    async executeAsync(command: CliProcessCommand): Promise<CliServerResponse> {
        logger.debug('Executing command: %s', command.command);
        const processor = this._registry.findProcessor(
            command.command,
            command.chainCommands?.length ? command.chainCommands : undefined,
        );

        if (!processor) {
            return {
                exitCode: 1,
                outputs: [
                    {
                        type: 'text',
                        value: `Unknown command: ${command.command}`,
                        style: 'error',
                    },
                ],
            };
        }

        if (this._filters.some(f => !f.isAllowed(processor))) {
            logger.warn('Command blocked by filter (plugin disabled): %s', command.command);
            return {
                exitCode: 1,
                outputs: [
                    {
                        type: 'text',
                        value: `Command '${command.command}' is currently disabled.`,
                        style: 'error',
                    },
                ],
            };
        }

        try {
            if (processor.handleStructuredAsync) {
                const response = await processor.handleStructuredAsync(command);
                logger.debug('Command completed: %s (exitCode=%d)', command.command, response.exitCode);
                return response;
            }

            const result = await processor.handleAsync(command);
            const response: CliServerResponse = {
                exitCode: 0,
                outputs: [{ type: 'text', value: result }],
            };
            logger.debug('Command completed: %s (exitCode=%d)', command.command, response.exitCode);
            return response;
        } catch (err: any) {
            logger.error('Command execution failed: %s - %s', command.command, err.message ?? err);
            return {
                exitCode: 1,
                outputs: [
                    {
                        type: 'text',
                        value: `Error executing command: ${err.message ?? err}`,
                        style: 'error',
                    },
                ],
            };
        }
    }
}
