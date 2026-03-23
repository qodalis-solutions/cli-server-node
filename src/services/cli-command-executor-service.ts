import { CliProcessCommand } from '../abstractions';
import { CliServerResponse } from '../models';
import { ICliCommandRegistry } from './cli-command-registry';

/** Service contract for executing parsed CLI commands. */
export interface ICliCommandExecutorService {
    /**
     * Executes a parsed command by routing it to the appropriate processor.
     * @param command - Parsed command to execute.
     * @returns Structured response with exit code and outputs.
     */
    executeAsync(command: CliProcessCommand): Promise<CliServerResponse>;
}

/** Default executor that resolves processors from the registry and delegates command handling. */
export class CliCommandExecutorService implements ICliCommandExecutorService {
    constructor(private readonly _registry: ICliCommandRegistry) {}

    async executeAsync(command: CliProcessCommand): Promise<CliServerResponse> {
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

        try {
            if (processor.handleStructuredAsync) {
                return await processor.handleStructuredAsync(command);
            }

            const result = await processor.handleAsync(command);
            return {
                exitCode: 0,
                outputs: [{ type: 'text', value: result }],
            };
        } catch (err: any) {
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
