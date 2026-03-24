import { ICliModule, ICliCommandProcessor, ICliProcessorFilter } from '@qodalis/cli-server-abstractions';

/**
 * Provides information about a tracked module for the admin dashboard.
 */
export interface ModuleInfo {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    enabled: boolean;
    processorCount: number;
    processors: string[];
}

interface TrackedModule {
    module: ICliModule;
    enabled: boolean;
    processors: ICliCommandProcessor[];
}

/**
 * Registry interface for the CliBuilder — the admin plugin only needs
 * register/unregister capabilities.
 */
export interface IRegistryLike {
    register(processor: ICliCommandProcessor): void;
    readonly processors: ReadonlyArray<ICliCommandProcessor>;
}

/**
 * Registry interface for the CliBuilder — the admin plugin reads modules from it.
 */
export interface IBuilderLike {
    readonly modules: ReadonlyArray<ICliModule>;
    readonly fileStorageProvider?: unknown;
    readonly fileSystemOptions?: unknown;
}

/**
 * Tracks registered CLI modules and allows toggling them on/off.
 * Implements {@link ICliProcessorFilter} to block execution of processors belonging to disabled modules.
 */
export class ModuleRegistry implements ICliProcessorFilter {
    private readonly _tracked = new Map<string, TrackedModule>();
    private readonly _processorToModuleId = new Map<ICliCommandProcessor, string>();
    private readonly _registry: IRegistryLike;
    private readonly _builder: IBuilderLike;

    constructor(registry: IRegistryLike, builder: IBuilderLike) {
        this._registry = registry;
        this._builder = builder;

        // Snapshot currently registered modules
        for (const mod of builder.modules) {
            const id = this.moduleId(mod);
            this._tracked.set(id, {
                module: mod,
                enabled: true,
                processors: [...mod.processors],
            });
            for (const processor of mod.processors) {
                this._processorToModuleId.set(processor, id);
            }
        }
    }

    /**
     * Determines whether the given command processor is allowed to execute.
     * Returns false when the processor belongs to a disabled module.
     */
    isAllowed(processor: ICliCommandProcessor): boolean {
        const moduleId = this._processorToModuleId.get(processor);
        if (!moduleId) {
            // Processor is not part of any tracked module — allow by default
            return true;
        }
        const tracked = this._tracked.get(moduleId);
        return tracked ? tracked.enabled : true;
    }

    /**
     * List all tracked modules with their current status.
     */
    list(): ModuleInfo[] {
        return Array.from(this._tracked.values()).map((t) => ({
            id: this.moduleId(t.module),
            name: t.module.name,
            version: t.module.version,
            description: t.module.description,
            author: typeof t.module.author === 'string'
                ? t.module.author
                : t.module.author?.name ?? 'Unknown',
            enabled: t.enabled,
            processorCount: t.processors.length,
            processors: t.processors.map(p => p.command),
        }));
    }

    /**
     * Toggle a module's enabled/disabled state.
     * When disabled, processors are blocked at execution time via the filter.
     * When enabled, they are re-registered if needed.
     */
    toggle(id: string): ModuleInfo | undefined {
        const tracked = this._tracked.get(id);
        if (!tracked) return undefined;

        tracked.enabled = !tracked.enabled;

        if (tracked.enabled) {
            // Re-register processors in case they were removed
            for (const processor of tracked.processors) {
                this._registry.register(processor);
            }
        }

        return this.toInfo(tracked);
    }

    private moduleId(mod: ICliModule): string {
        return mod.name.toLowerCase().replace(/\s+/g, '-');
    }

    private toInfo(t: TrackedModule): ModuleInfo {
        return {
            id: this.moduleId(t.module),
            name: t.module.name,
            version: t.module.version,
            description: t.module.description,
            author: typeof t.module.author === 'string'
                ? t.module.author
                : t.module.author?.name ?? 'Unknown',
            enabled: t.enabled,
            processorCount: t.processors.length,
            processors: t.processors.map(p => p.command),
        };
    }
}
