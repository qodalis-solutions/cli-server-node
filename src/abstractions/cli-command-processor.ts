import { ICliCommandAuthor, DefaultLibraryAuthor } from './cli-command-author';
import { ICliCommandParameterDescriptor } from './cli-command-parameter-descriptor';
import { CliProcessCommand } from './cli-process-command';

export interface ICliCommandProcessor {
    command: string;
    description: string;
    author: ICliCommandAuthor;
    allowUnlistedCommands?: boolean;
    valueRequired?: boolean;
    version: string;
    processors?: ICliCommandProcessor[];
    parameters?: ICliCommandParameterDescriptor[];
    handleAsync(command: CliProcessCommand): Promise<string>;
}

export abstract class CliCommandProcessor implements ICliCommandProcessor {
    abstract command: string;
    abstract description: string;
    author: ICliCommandAuthor = DefaultLibraryAuthor;
    allowUnlistedCommands?: boolean;
    valueRequired?: boolean;
    version: string = '1.0.0';
    processors?: ICliCommandProcessor[];
    parameters?: ICliCommandParameterDescriptor[];

    abstract handleAsync(command: CliProcessCommand): Promise<string>;
}
