import { ICliCommandProcessor } from '../abstractions';

export interface ICliCommandRegistry {
    readonly processors: ReadonlyArray<ICliCommandProcessor>;
    register(processor: ICliCommandProcessor): void;
    findProcessor(command: string, chainCommands?: string[]): ICliCommandProcessor | undefined;
}

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
