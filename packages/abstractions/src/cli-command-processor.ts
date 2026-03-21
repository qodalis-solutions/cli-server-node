import { ICliCommandAuthor, DefaultLibraryAuthor } from './cli-command-author';
import { ICliCommandParameterDescriptor } from './cli-command-parameter-descriptor';
import { CliProcessCommand } from './cli-process-command';
import { CliStructuredResponse } from './cli-structured-response';

export interface ICliCommandProcessor {
    command: string;
    description: string;
    author: ICliCommandAuthor;
    allowUnlistedCommands?: boolean;
    valueRequired?: boolean;
    version: string;
    /** Minimum API version this processor is available in. Defaults to 1. */
    apiVersion?: number;
    processors?: ICliCommandProcessor[];
    parameters?: ICliCommandParameterDescriptor[];
    handleAsync(command: CliProcessCommand): Promise<string>;
    handleStructuredAsync?(command: CliProcessCommand): Promise<CliStructuredResponse>;
}

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
