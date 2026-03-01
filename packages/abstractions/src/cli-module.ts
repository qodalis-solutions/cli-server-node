import { ICliCommandProcessor } from './cli-command-processor';
import { ICliCommandAuthor, DefaultLibraryAuthor } from './cli-command-author';

/**
 * Represents a module that bundles one or more command processors.
 */
export interface ICliModule {
    /** Unique name of the module. */
    name: string;

    /** Module version. */
    version: string;

    /** Short description of the module. */
    description: string;

    /** Author of the module. */
    author: ICliCommandAuthor;

    /** Command processors provided by this module. */
    processors: ICliCommandProcessor[];
}

/**
 * Base class for CLI modules providing sensible defaults.
 */
export abstract class CliModule implements ICliModule {
    abstract name: string;
    abstract version: string;
    abstract description: string;
    author: ICliCommandAuthor = DefaultLibraryAuthor;
    abstract processors: ICliCommandProcessor[];
}
