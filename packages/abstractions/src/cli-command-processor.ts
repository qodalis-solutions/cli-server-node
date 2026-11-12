import { ICliCommandAuthor, DefaultLibraryAuthor } from './cli-command-author';
import { ICliCommandParameterDescriptor } from './cli-command-parameter-descriptor';
import { CliProcessCommand } from './cli-process-command';
import { CliStructuredResponse } from './cli-structured-response';

/** An example command line shown in a command's help. */
export interface CliCommandExample {
    /** The command line, e.g. `hash sha256 hello`. */
    command: string;
    /** What it does. */
    description?: string;
}

/** Contract for a CLI command processor that handles one command (and optionally sub-commands). */
export interface ICliCommandProcessor {
    /** Primary command keyword (e.g. "echo", "hash"). */
    command: string;
    /** Short description shown in help/listing output. */
    description: string;
    /**
     * Other names of the command (root or sub-command). The server resolves them like the
     * command itself, for `/execute`, streaming and permissions.
     */
    aliases?: string[];
    /** Example command lines for the command's help. */
    examples?: CliCommandExample[];
    /** Longer help text for `help <command>`: plain text, paragraphs separated by a blank line. */
    documentation?: string;
    /** The group the command is listed under in the web CLI's help (e.g. "weather"). */
    module?: string;
    /** One emoji shown next to the command in the web CLI's help. */
    icon?: string;
    /** Author metadata for this processor. */
    author: ICliCommandAuthor;
    /** When true, sub-commands not listed in {@link processors} are forwarded to this processor. */
    allowUnlistedCommands?: boolean;
    /** When true, the command requires a positional value argument. */
    valueRequired?: boolean;
    /**
     * When true, the command reads an optional positional value (`command.value`).
     * Implied by {@link valueRequired}. MCP exposes it as an optional `value` argument.
     */
    acceptsValue?: boolean;
    /** Semantic version of this processor. */
    version: string;
    /** Nested sub-command processors. */
    processors?: ICliCommandProcessor[];
    /** Parameter descriptors for this command. */
    parameters?: ICliCommandParameterDescriptor[];
    /**
     * Permissions required to execute this command (all of them), enforced
     * server-side when the users plugin protects the server.
     */
    requiredPermissions?: string[];
    /**
     * Executes the command and returns a plain-text result.
     * @param command - Parsed command with arguments.
     * @param signal - Optional AbortSignal to cancel the operation.
     * @returns Plain-text output string.
     */
    handleAsync(command: CliProcessCommand, signal?: AbortSignal): Promise<string>;
    /**
     * Executes the command and returns a structured response with typed outputs.
     * When implemented, takes precedence over {@link handleAsync}.
     * @param command - Parsed command with arguments.
     * @param signal - Optional AbortSignal to cancel the operation.
     * @returns Structured response containing exit code and typed outputs.
     */
    handleStructuredAsync?(command: CliProcessCommand, signal?: AbortSignal): Promise<CliStructuredResponse>;
}

/**
 * Abstract base class for CLI command processors with sensible defaults.
 * Extend this class and implement {@link handleAsync} to create a new command.
 */
export abstract class CliCommandProcessor implements ICliCommandProcessor {
    abstract command: string;
    abstract description: string;
    aliases?: string[];
    examples?: CliCommandExample[];
    documentation?: string;
    module?: string;
    icon?: string;
    author: ICliCommandAuthor = DefaultLibraryAuthor;
    allowUnlistedCommands?: boolean;
    valueRequired?: boolean;
    acceptsValue?: boolean;
    version: string = '1.0.0';
    processors?: ICliCommandProcessor[];
    parameters?: ICliCommandParameterDescriptor[];
    requiredPermissions?: string[];

    abstract handleAsync(command: CliProcessCommand, signal?: AbortSignal): Promise<string>;
    handleStructuredAsync?(command: CliProcessCommand, signal?: AbortSignal): Promise<CliStructuredResponse>;
}

/** Whether `name` is the processor's command or one of its aliases (ignoring case). */
export function commandMatches(processor: Pick<ICliCommandProcessor, 'command' | 'aliases'>, name: string): boolean {
    const lower = name.toLowerCase();
    return processor.command.toLowerCase() === lower || (processor.aliases ?? []).some((a) => a.toLowerCase() === lower);
}
