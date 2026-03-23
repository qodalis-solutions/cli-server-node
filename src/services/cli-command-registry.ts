import { ICliCommandProcessor } from '../abstractions';

/** Registry that stores and looks up CLI command processors by command name. */
export interface ICliCommandRegistry {
    /** All registered top-level processors. */
    readonly processors: ReadonlyArray<ICliCommandProcessor>;
    /** Registers a command processor. */
    register(processor: ICliCommandProcessor): void;
    /**
     * Finds a processor by command name, optionally resolving a sub-command chain.
     * @param command - Top-level command name.
     * @param chainCommands - Optional sub-command chain to resolve.
     * @returns Matching processor, or undefined if not found.
     */
    findProcessor(command: string, chainCommands?: string[]): ICliCommandProcessor | undefined;
}

/** Default in-memory implementation of {@link ICliCommandRegistry}. */
export class CliCommandRegistry implements ICliCommandRegistry {
    private _processors: Map<string, ICliCommandProcessor> = new Map();

    get processors(): ReadonlyArray<ICliCommandProcessor> {
        return Array.from(this._processors.values());
    }

    register(processor: ICliCommandProcessor): void {
        this._processors.set(processor.command.toLowerCase(), processor);
    }

    findProcessor(command: string, chainCommands?: string[]): ICliCommandProcessor | undefined {
        const processor = this._processors.get(command.toLowerCase());
        if (!processor || !chainCommands?.length) {
            return processor;
        }

        return this.resolveChain(processor, chainCommands);
    }

    /** Walks the sub-processor tree to resolve a chain of sub-commands. */
    private resolveChain(
        processor: ICliCommandProcessor,
        chainCommands: string[],
    ): ICliCommandProcessor | undefined {
        let current = processor;

        for (const sub of chainCommands) {
            const child = current.processors?.find(
                (p) => p.command.toLowerCase() === sub.toLowerCase(),
            );
            if (!child) {
                return current.allowUnlistedCommands ? current : undefined;
            }
            current = child;
        }

        return current;
    }
}
