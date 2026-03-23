import { CliProcessCommand } from './cli-process-command';
import { CliStructuredOutput } from './cli-structured-response';

/**
 * Optional interface for command processors that support streaming output.
 * Processors implementing this interface can emit output chunks incrementally
 * via the `emit` callback, enabling real-time rendering on the client.
 *
 * A processor can implement both ICliCommandProcessor and ICliStreamCommandProcessor.
 * The stream execution endpoint will prefer this interface when available.
 */
export interface ICliStreamCommandProcessor {
    /** Must match the command keyword of the corresponding ICliCommandProcessor. */
    readonly command: string;

    /**
     * Execute the command, emitting output chunks as they become available.
     * @param command - Parsed command with arguments.
     * @param emit - Callback to send a single output chunk to the client.
     * @returns Exit code (0 for success).
     */
    handleStreamAsync(
        command: CliProcessCommand,
        emit: (output: CliStructuredOutput) => void,
    ): Promise<number>;
}

/**
 * Type guard to check if a processor supports streaming.
 */
export function isStreamCapable(
    processor: unknown,
): processor is ICliStreamCommandProcessor {
    return (
        typeof processor === 'object' &&
        processor !== null &&
        'handleStreamAsync' in processor &&
        typeof (processor as any).handleStreamAsync === 'function'
    );
}
