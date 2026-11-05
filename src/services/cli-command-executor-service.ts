import { CliProcessCommand, ICliCommandProcessor, ICliProcessorFilter } from '../abstractions';
import { CliServerResponse } from '../models';
import { ICliCommandRegistry } from './cli-command-registry';
import { createLogger } from '../utils/logger';
import { CliOutputLimits, DEFAULT_MAX_TABLE_ROWS } from './cli-output-limits';
import { CliCommandUsageStats } from './cli-command-usage-stats';

const logger = createLogger('CommandExecutor');

/** Service contract for executing parsed CLI commands. */
export interface ICliCommandExecutorService {
    /**
     * Executes a parsed command by routing it to the appropriate processor.
     * @param command - Parsed command to execute.
     * @param signal - Optional AbortSignal to cancel the operation.
     * @returns Structured response with exit code and outputs.
     */
    executeAsync(command: CliProcessCommand, signal?: AbortSignal): Promise<CliServerResponse>;

    /**
     * Adds a processor filter that can block command execution at runtime.
     * @param filter - The filter to add.
     */
    addFilter(filter: ICliProcessorFilter): void;

    /**
     * Returns true if any registered filter blocks the given processor.
     * @param processor - The processor to check.
     */
    isBlocked(processor: ICliCommandProcessor): boolean;

    /**
     * The most rows an unpaged table may return (0 = no limit); `/execute/stream` caps
     * streamed tables with it. Defaults to {@link DEFAULT_MAX_TABLE_ROWS} when not set.
     */
    readonly maxTableRows?: number;

    /**
     * Command usage counters (`GET /api/v1/qcli/commands/stats`): `executeAsync` records
     * every execution; `/execute/stream` records its own.
     */
    readonly usage?: CliCommandUsageStats;
}

/** Options for {@link CliCommandExecutorService}. */
export interface CliCommandExecutorOptions {
    /**
     * The most rows a table may return without paging (default 200; 0 = no limit). A larger
     * table from a command that does not page (`writePagedTable`) is cut to this many rows
     * and marked `truncated`, so a terminal never receives thousands of rows at once.
     */
    maxTableRows?: number;
}

/** Default executor that resolves processors from the registry and delegates command handling. */
export class CliCommandExecutorService implements ICliCommandExecutorService {
    private readonly _filters: ICliProcessorFilter[] = [];

    /** The most rows an unpaged table may return (0 = no limit). */
    readonly maxTableRows: number;

    /** Usage counters of the commands run through this executor, since it was created. */
    readonly usage = new CliCommandUsageStats();

    constructor(
        private readonly _registry: ICliCommandRegistry,
        options: CliCommandExecutorOptions = {},
    ) {
        this.maxTableRows = options.maxTableRows ?? DEFAULT_MAX_TABLE_ROWS;
    }

    addFilter(filter: ICliProcessorFilter): void {
        this._filters.push(filter);
    }

    isBlocked(processor: ICliCommandProcessor): boolean {
        return this._filters.some(f => !f.isAllowed(processor));
    }

    async executeAsync(command: CliProcessCommand, signal?: AbortSignal): Promise<CliServerResponse> {
        const started = Date.now();
        let response: CliServerResponse | undefined;
        try {
            response = await this.run(command, signal);
            return response;
        } finally {
            const known = typeof command?.command === 'string' && !!this._registry.findProcessor(command.command);
            this.usage.record(command?.command, known, Date.now() - started, !response || response.exitCode !== 0);
        }
    }

    /** Resolves the command's processor and runs it. */
    private async run(command: CliProcessCommand, signal?: AbortSignal): Promise<CliServerResponse> {
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

        if (this.isBlocked(processor)) {
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
                const response = await processor.handleStructuredAsync(command, signal);
                logger.debug('Command completed: %s (exitCode=%d)', command.command, response.exitCode);
                return CliOutputLimits.applyResponse(response, this.maxTableRows);
            }

            const result = await processor.handleAsync(command, signal);
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
