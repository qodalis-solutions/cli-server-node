import { ICliCommandProcessor } from './cli-command-processor';

/**
 * Provides a mechanism to filter whether a command processor is allowed to execute.
 * Implementations can use this to disable processors at runtime (e.g., when a plugin is toggled off).
 */
export interface ICliProcessorFilter {
    /**
     * Determines whether the given command processor is allowed to execute.
     * @param processor - The command processor to check.
     * @returns `true` if the processor is allowed; `false` if it should be blocked.
     */
    isAllowed(processor: ICliCommandProcessor): boolean;
}
