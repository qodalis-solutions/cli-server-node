import type { CliPermission, UsersPermissionCatalog } from './models';

/**
 * Permission strings are `resource:action`. A `*` as the last segment matches
 * that level and everything below it (`*`, `users:*`); a `*` in any other
 * segment matches exactly one segment (`*:read` matches `users:read`, not
 * `users:delete`). Matching is case-insensitive.
 * Same semantics as `cliPermissionMatches` in `@qodalis/cli-core`.
 */
export function permissionMatches(granted: string, required: string): boolean {
    const g = granted.trim().toLowerCase().split(':');
    const r = required.trim().toLowerCase().split(':');
    for (let i = 0; i < g.length; i++) {
        if (g[i] === '*' && i === g.length - 1) return true;
        if (i >= r.length || (g[i] !== '*' && g[i] !== r[i])) return false;
    }
    return g.length === r.length;
}

export function hasPermission(granted: readonly string[] | undefined, required: string): boolean {
    return !!granted?.some((p) => permissionMatches(p, required));
}

/** Union of permission lists, de-duplicated case-insensitively, first-seen order. */
export function mergePermissions(...lists: (readonly string[] | undefined)[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of lists) {
        for (const p of list ?? []) {
            const key = p.trim();
            if (key && !seen.has(key.toLowerCase())) {
                seen.add(key.toLowerCase());
                out.push(key);
            }
        }
    }
    return out;
}

export const UsersPermissions = {
    UsersRead: 'users:read',
    UsersCreate: 'users:create',
    UsersUpdate: 'users:update',
    UsersDelete: 'users:delete',
    GroupsRead: 'groups:read',
    GroupsCreate: 'groups:create',
    GroupsUpdate: 'groups:update',
    GroupsDelete: 'groups:delete',
    SessionsRead: 'sessions:read',
    SessionsRevoke: 'sessions:revoke',
    AuditRead: 'audit:read',
    AuditClear: 'audit:clear',
    TokensRead: 'tokens:read',
    TokensRevoke: 'tokens:revoke',
} as const;

export const ADMIN_GROUP = 'admin';
export const USERS_GROUP = 'users';
export const BUILT_IN_GROUPS = [ADMIN_GROUP, USERS_GROUP];

export function sameName(a: string | undefined, b: string | undefined): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function inGroup(groups: readonly string[] | undefined, group: string): boolean {
    return !!groups?.some((g) => sameName(g, group));
}

/** The permissions the users plugin checks, registered in the server's catalog as `cli`. */
export const USERS_PERMISSION_ENTRIES: readonly Omit<CliPermission, 'surface'>[] = [
    { name: 'users:read', description: 'See users and their permissions', group: 'Users' },
    { name: 'users:create', description: 'Create users', group: 'Users' },
    { name: 'users:update', description: 'Change users, their groups and passwords', group: 'Users' },
    { name: 'users:delete', description: 'Delete users', group: 'Users' },
    { name: 'groups:read', description: 'See groups', group: 'Groups' },
    { name: 'groups:create', description: 'Create groups', group: 'Groups' },
    { name: 'groups:update', description: 'Change groups and their permissions', group: 'Groups' },
    { name: 'groups:delete', description: 'Delete groups', group: 'Groups' },
    { name: 'sessions:read', description: "See every user's sessions", group: 'Sessions' },
    { name: 'sessions:revoke', description: "End other users' sessions", group: 'Sessions' },
    { name: 'tokens:read', description: "See every user's API tokens", group: 'Tokens' },
    { name: 'tokens:revoke', description: "Revoke other users' API tokens", group: 'Tokens' },
];

const CATALOG_NAME_RE = /^[a-z0-9_.-]+:[a-z0-9_.-]+$/;

/**
 * The plugin's own catalog, used until `attachToServer` hands it the server's
 * (`builder.permissions`), e.g. when the router is mounted without a CLI server.
 * Same rules as core's `CliPermissionCatalog`, which the plugin cannot import (it
 * must run against older servers).
 */
export class LocalPermissionCatalog implements UsersPermissionCatalog {
    private readonly entries: CliPermission[] = [];

    constructor(entries: readonly Omit<CliPermission, 'surface'>[] = [], surface: 'cli' | 'host' = 'cli') {
        this.add(entries, surface);
    }

    add(entries: readonly Omit<CliPermission, 'surface'>[], surface: 'cli' | 'host'): void {
        const batch = new Set<string>();
        for (const entry of entries) {
            const key = typeof entry?.name === 'string' ? entry.name.toLowerCase() : undefined;
            if (key && (this.find(key) || batch.has(key))) {
                throw new Error(`permission already registered: ${entry.name}`);
            }
            const valid =
                !!key &&
                CATALOG_NAME_RE.test(entry.name) &&
                typeof entry.description === 'string' &&
                entry.description.length >= 1 &&
                entry.description.length <= 200 &&
                !/[\r\n]/.test(entry.description) &&
                typeof entry.group === 'string' &&
                entry.group.length >= 1 &&
                entry.group.length <= 64 &&
                (surface === 'cli' || surface === 'host');
            if (!valid) {
                throw new Error(`invalid permission entry: ${entry?.name ?? ''}`);
            }
            batch.add(key!);
        }
        for (const entry of entries) {
            this.entries.push({ name: entry.name, description: entry.description, group: entry.group, surface });
        }
    }

    all(): CliPermission[] {
        return [
            ...this.entries.filter((p) => p.surface === 'cli'),
            ...this.entries.filter((p) => p.surface === 'host'),
        ].map((p) => ({ ...p }));
    }

    find(name: string): CliPermission | undefined {
        const lower = typeof name === 'string' ? name.toLowerCase() : undefined;
        const found = this.entries.find((p) => p.name.toLowerCase() === lower);
        return found ? { ...found } : undefined;
    }
}
