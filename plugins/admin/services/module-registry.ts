import type { CliInstalledPlugin } from './package-info';
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
    /** One emoji or an image URL for the module (`ICliModule.icon`); null when it has none. */
    icon: string | null;
    enabled: boolean;
    processorCount: number;
    processors: string[];
}

/** A module as the dashboard lists it: an added module, or a group of commands added on their own. */
interface ModuleEntry {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    icon: string | undefined;
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
    /**
     * The server's runtime options (`CliServerRuntimeOptions` of `@qodalis/cli-server-node`):
     * `externalAuthentication` selects the dashboard's sign-in mode, `jobsEnabled` reports "jobs".
     */
    readonly serverOptions?: { readonly externalAuthentication?: boolean; readonly jobsEnabled?: boolean };
    /**
     * The server plugin packages installed so far (`CliBuilder.installedPlugins` of
     * `@qodalis/cli-server-node`), listed by `GET /plugins/installed`.
     */
    readonly installedPlugins?: ReadonlyArray<CliInstalledPlugin>;
}

/** The id of a module or command group: its name in lower case, spaces as dashes. */
function moduleId(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-');
}

function authorName(author: ICliModule['author'] | string | undefined, fallback: string): string {
    return typeof author === 'string' ? author : author?.name ?? fallback;
}

/**
 * Tracks registered CLI modules and allows toggling them on/off.
 * Implements {@link ICliProcessorFilter} to block execution of processors belonging to disabled modules.
 * Commands registered on their own (`addProcessor`) join the module their `module` property names
 * (case-insensitive): a module added with that name (it may have no processors of its own, only
 * describe the group: description, version, icon), or else a module of that name made from the commands.
 */
export class ModuleRegistry implements ICliProcessorFilter {
    /** Disabled state by module id (absent = enabled). */
    private readonly _disabled = new Set<string>();
    private readonly _registry: IRegistryLike;
    private readonly _builder: IBuilderLike;

    constructor(registry: IRegistryLike, builder: IBuilderLike) {
        this._registry = registry;
        this._builder = builder;
    }

    /**
     * The modules added to the builder, then the groups of commands registered on their own, read on
     * every call so commands registered after the admin plugin are listed too.
     */
    private entries(): ModuleEntry[] {
        const entries: ModuleEntry[] = this._builder.modules.map((m) => ({
            id: moduleId(m.name),
            name: m.name,
            version: m.version,
            description: m.description,
            author: authorName(m.author, 'Unknown'),
            icon: m.icon,
            processors: [...m.processors],
        }));
        const owned = new Set(entries.flatMap((e) => e.processors));
        for (const processor of this._registry.processors) {
            if (owned.has(processor) || !processor.module?.trim()) continue;
            const id = moduleId(processor.module);
            const entry = entries.find((e) => e.id === id);
            if (entry) {
                entry.processors.push(processor);
            } else {
                // No module describes the group: the first command's version and author
                entries.push({
                    id,
                    name: processor.module,
                    version: processor.version ?? '',
                    description: '',
                    author: authorName(processor.author, ''),
                    icon: undefined,
                    processors: [processor],
                });
            }
        }
        return entries;
    }

    /**
     * Determines whether the given command processor is allowed to execute.
     * Returns false when the processor belongs to a disabled module or command group.
     */
    isAllowed(processor: ICliCommandProcessor): boolean {
        if (this._disabled.size === 0) return true;
        const owner = this._builder.modules.find((m) => m.processors.includes(processor));
        const name = owner?.name ?? processor.module;
        return !name?.trim() || !this._disabled.has(moduleId(name));
    }

    /**
     * List all tracked modules with their current status.
     */
    list(): ModuleInfo[] {
        return this.entries().map((e) => this.toInfo(e));
    }

    /** A module or command group by id (case-insensitive), or undefined. */
    getById(id: string): ModuleInfo | undefined {
        const entry = this.find(id);
        return entry ? this.toInfo(entry) : undefined;
    }

    /**
     * Toggle a module's enabled/disabled state.
     * When disabled, processors are blocked at execution time via the filter.
     * When enabled, they are re-registered if needed.
     */
    toggle(id: string): ModuleInfo | undefined {
        const entry = this.find(id);
        if (!entry) return undefined;

        if (this._disabled.has(entry.id)) {
            this._disabled.delete(entry.id);
            // Re-register processors in case they were removed
            for (const processor of entry.processors) {
                this._registry.register(processor);
            }
        } else {
            this._disabled.add(entry.id);
        }

        return this.toInfo(entry);
    }

    private find(id: string): ModuleEntry | undefined {
        const key = moduleId(id);
        return this.entries().find((e) => e.id === key);
    }

    private toInfo(e: ModuleEntry): ModuleInfo {
        return {
            id: e.id,
            name: e.name,
            version: e.version,
            description: e.description,
            author: e.author,
            icon: e.icon ?? null,
            enabled: !this._disabled.has(e.id),
            processorCount: e.processors.length,
            processors: e.processors.map((p) => p.command),
        };
    }
}
