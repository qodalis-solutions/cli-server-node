import { ICliCommandProcessor } from '../abstractions';
import { CliCommandRegistry } from '../services';

export class CliBuilder {
    private readonly _registry: CliCommandRegistry;

    constructor(registry: CliCommandRegistry) {
        this._registry = registry;
    }

    addProcessor(processor: ICliCommandProcessor): CliBuilder {
        this._registry.register(processor);
        return this;
    }

    get registry(): CliCommandRegistry {
        return this._registry;
    }
}
