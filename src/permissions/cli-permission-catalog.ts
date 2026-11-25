/** Who a permission is for: the CLI's own routes (`cli`) or the host application's routes (`host`). */
export type CliPermissionSurface = 'cli' | 'host';

/**
 * A known permission, listed by `GET /api/v1/qcli/permissions` so clients can offer
 * it when creating a token. The catalog is for choosing, not for validation: unknown
 * and wildcard permissions stay accepted on CLI tokens.
 */
export interface CliPermission {
    /** A concrete permission: lower case `resource:action`, no `*`. */
    name: string;
    /** One line, 1-200 characters. */
    description: string;
    /** A heading such as `Files` or `Rates` (1-64 characters). */
    group: string;
    surface: CliPermissionSurface;
}

/** A catalog entry as registered; the surface is given by the registration. */
export type CliPermissionInput = Omit<CliPermission, 'surface'>;

const NAME_RE = /^[a-z0-9_.-]+:[a-z0-9_.-]+$/;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_GROUP_LENGTH = 64;

/** The permissions core's route policy checks (registered as `cli`). */
export const CORE_PERMISSIONS: readonly CliPermissionInput[] = [
    { name: 'commands:execute', description: 'Run commands on the server', group: 'Commands' },
    { name: 'shell:execute', description: 'Open an interactive shell on the server', group: 'Commands' },
    { name: 'http:request', description: 'Make HTTP requests from the server', group: 'Commands' },
    { name: 'files:read', description: 'List, read and download files', group: 'Files' },
    { name: 'files:write', description: 'Upload, create and delete files', group: 'Files' },
    { name: 'data:query', description: "Query the data explorer's sources", group: 'Data' },
    { name: 'jobs:read', description: 'See jobs and their runs', group: 'Jobs' },
    { name: 'jobs:manage', description: 'Start, stop, pause and change jobs', group: 'Jobs' },
    { name: 'logs:read', description: "Read the server's logs", group: 'Server' },
    { name: 'admin:access', description: 'Open the admin dashboard and its server pages', group: 'Server' },
    { name: 'dashboard:install', description: 'Install, update and remove dashboard plugins from the marketplace', group: 'Server' },
    { name: 'config:read', description: "See the server's configuration (secrets stay hidden)", group: 'Config' },
    { name: 'config:write', description: "Change the server's configuration", group: 'Config' },
    { name: 'audit:read', description: 'Read the audit log', group: 'Audit' },
    { name: 'audit:clear', description: 'Clear the audit log', group: 'Audit' },
];

function isValidEntry(entry: CliPermissionInput, surface: CliPermissionSurface): boolean {
    const { name, description, group } = entry ?? ({} as CliPermissionInput);
    return (
        typeof name === 'string' &&
        NAME_RE.test(name) &&
        typeof description === 'string' &&
        description.length >= 1 &&
        description.length <= MAX_DESCRIPTION_LENGTH &&
        !/[\r\n]/.test(description) &&
        typeof group === 'string' &&
        group.length >= 1 &&
        group.length <= MAX_GROUP_LENGTH &&
        (surface === 'cli' || surface === 'host')
    );
}

/**
 * The server's permission catalog: core's entries, then the plugins' in the order
 * they are added, then the host's. Filled at startup; names are unique
 * case-insensitively.
 */
export class CliPermissionCatalog {
    private readonly entries: CliPermission[] = [];
    private readonly byName = new Map<string, CliPermission>();

    /**
     * Registers entries with the given surface. Throws `invalid permission entry: <name>`
     * or `permission already registered: <name>`; nothing is added when one entry fails.
     */
    add(entries: readonly CliPermissionInput[], surface: CliPermissionSurface): void {
        const batch = new Set<string>();
        for (const entry of entries) {
            // A name already taken is reported as such, whatever its spelling (`FILES:READ`)
            const key = typeof entry?.name === 'string' ? entry.name.toLowerCase() : undefined;
            if (key && (this.byName.has(key) || batch.has(key))) {
                throw new Error(`permission already registered: ${entry.name}`);
            }
            if (!isValidEntry(entry, surface)) {
                throw new Error(`invalid permission entry: ${entry?.name ?? ''}`);
            }
            batch.add(key!);
        }
        for (const entry of entries) {
            const permission: CliPermission = { name: entry.name, description: entry.description, group: entry.group, surface };
            this.entries.push(permission);
            this.byName.set(entry.name.toLowerCase(), permission);
        }
    }

    /**
     * Every entry (copies): the `cli` entries in registration order, then the `host`
     * entries in registration order, so the host's come last even when it registers
     * them before a plugin is mounted.
     */
    all(): CliPermission[] {
        return [
            ...this.entries.filter((p) => p.surface === 'cli'),
            ...this.entries.filter((p) => p.surface === 'host'),
        ].map((p) => ({ ...p }));
    }

    /** The entry with this name (case-insensitive), as a copy. */
    find(name: string): CliPermission | undefined {
        const permission = typeof name === 'string' ? this.byName.get(name.toLowerCase()) : undefined;
        return permission ? { ...permission } : undefined;
    }
}
