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
