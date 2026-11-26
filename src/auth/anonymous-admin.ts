/**
 * Permissions that install code or change the server's configuration. On a server no auth provider
 * protects, a caller without sign-in (an anonymous `/execute`, the MCP endpoint, a terminal) is refused
 * them unless the host sets `createCliServer({ allowAnonymousAdmin: true })`: anyone who can reach the
 * server could otherwise install a plugin, which runs code in the server, or rewrite its settings.
 */
export const ANONYMOUS_ADMIN_PERMISSIONS: readonly string[] = ['plugins:install', 'dashboard:install', 'config:write', 'server:restart'];

/** The option of `createCliServer` that lets anonymous callers use {@link ANONYMOUS_ADMIN_PERMISSIONS}. */
export const ALLOW_ANONYMOUS_ADMIN_OPTION = 'allowAnonymousAdmin';

/** The refusal for anonymous callers (no permission names, so the message stays stable). */
export const ANONYMOUS_ADMIN_REFUSAL = `sign-in required: protect the server (users plugin) or set ${ALLOW_ANONYMOUS_ADMIN_OPTION}: true`;

/** The permissions of `required` that anonymous callers are refused (lower case, unique). */
export function anonymousAdminPermissions(required: readonly string[] | undefined): string[] {
    const out = new Set<string>();
    for (const p of required ?? []) {
        const name = typeof p === 'string' ? p.trim().toLowerCase() : '';
        if (ANONYMOUS_ADMIN_PERMISSIONS.includes(name)) out.add(name);
    }
    return [...out];
}

/**
 * The refusal for an anonymous caller needing `required`, or undefined when none of them is refused.
 * The caller decides whether the request is anonymous and the server unprotected.
 */
export function anonymousAdminRefusal(required: readonly string[] | undefined): string | undefined {
    const refused = anonymousAdminPermissions(required);
    return refused.length > 0 ? `${ANONYMOUS_ADMIN_REFUSAL} (${refused.join(', ')})` : undefined;
}
