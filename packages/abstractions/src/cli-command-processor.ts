import { ICliCommandAuthor, DefaultLibraryAuthor } from './cli-command-author';
import { ICliCommandParameterDescriptor } from './cli-command-parameter-descriptor';
import { CliProcessCommand } from './cli-process-command';
import { CliStructuredResponse } from './cli-structured-response';

/** Contract for a CLI command processor that handles one command (and optionally sub-commands). */
export interface ICliCommandProcessor {
    /** Primary command keyword (e.g. "echo", "hash"). */
    command: string;
    /** Short description shown in help/listing output. */
    description: string;
    /** Author metadata for this processor. */
    author: ICliCommandAuthor;
    /** When true, sub-commands not listed in {@link processors} are forwarded to this processor. */
    allowUnlistedCommands?: boolean;
    /** When true, the command requires a positional value argument. */
    valueRequired?: boolean;
    /** Semantic version of this processor. */
    version: string;
    /** Minimum API version this processor is available in. Defaults to 1. */
    apiVersion?: number;
    /** Nested sub-command processors. */
    processors?: ICliCommandProcessor[];
    /** Parameter descriptors for this command. */
    parameters?: ICliCommandParameterDescriptor[];
    /**
     * Executes the command and returns a plain-text result.
     * @param command - Parsed command with arguments.
     * @returns Plain-text output string.
     */
    handleAsync(command: CliProcessCommand): Promise<string>;
    /**
     * Executes the command and returns a structured response with typed outputs.
     * When implemented, takes precedence over {@link handleAsync}.
     * @param command - Parsed command with arguments.
     * @returns Structured response containing exit code and typed outputs.
     */
    handleStructuredAsync?(command: CliProcessCommand): Promise<CliStructuredResponse>;
}

/**
 * Abstract base class for CLI command processors with sensible defaults.
 * Extend this class and implement {@link handleAsync} to create a new command.
 */
export abstract class CliCommandProcessor implements ICliCommandProcessor {
    abstract command: string;
    abstract description: string;
    author: ICliCommandAuthor = DefaultLibraryAuthor;
    allowUnlistedCommands?: boolean;
    valueRequired?: boolean;
    version: string = '1.0.0';
    apiVersion: number = 1;
    processors?: ICliCommandProcessor[];
    parameters?: ICliCommandParameterDescriptor[];

    abstract handleAsync(command: CliProcessCommand): Promise<string>;
    handleStructuredAsync?(command: CliProcessCommand): Promise<CliStructuredResponse>;
}
