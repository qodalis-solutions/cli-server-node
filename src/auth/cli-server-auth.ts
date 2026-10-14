import type { Request } from 'express';

/** Identity of an authenticated caller (HTTP request or WebSocket). */
export interface CliServerAuthContext {
    userId: string;
    userName: string;
    /** Absent for host-authenticated (adapter) callers. */
    sessionId?: string;
    /** Effective permissions (`resource:action`, `*` wildcards). */
    permissions: string[];
}

/** Error thrown by {@link ICliServerAuth.authenticateRequest}; rendered as `{ error }`. */
export interface CliServerAuthError extends Error {
    status?: number;
}

/**
 * Authentication provider that protects the whole CLI server (routes and
 * sockets). Implemented by the users plugin (`usersPlugin.serverAuth`).
 */
export interface ICliServerAuth {
    /** When false the server stays open; sockets only use tickets for optional identity. */
    readonly protectServer: boolean;
    /** True for routes the provider authenticates itself (its own API, its login). */
    handlesPath(path: string, method: string): boolean;
    /**
     * Authenticates an HTTP request. Throws an error with `status`
     * (401 unauthenticated, 403 e.g. password change required / CSRF).
     */
    authenticateRequest(req: Request): Promise<CliServerAuthContext>;
    /** Consumes a single-use WebSocket ticket; undefined when invalid/expired/used. */
    consumeTicket(ticket: string): Promise<CliServerAuthContext | undefined>;
    hasPermission(ctx: CliServerAuthContext, permission: string): boolean;
    /** Called once when installed into a server. */
    attachToServer?(server: {
        allowedOrigins?: string[];
        broadcast: (message: Record<string, unknown>) => void;
    }): void;
}

/** Server permissions enforced when the users plugin protects the server. */
export const CliServerPermissions = {
    CommandsExecute: 'commands:execute',
    FilesRead: 'files:read',
    FilesWrite: 'files:write',
    DataQuery: 'data:query',
    JobsRead: 'jobs:read',
    JobsManage: 'jobs:manage',
    LogsRead: 'logs:read',
    ShellExecute: 'shell:execute',
    AdminAccess: 'admin:access',
} as const;

/**
 * Exact origin match. An entry ending in `:*` matches any port of that
 * scheme+host (e.g. `http://127.0.0.1:*`).
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[] | undefined): boolean {
    if (!origin || !allowed || allowed.length === 0) return false;
    const o = origin.toLowerCase().replace(/\/+$/, '');
    return allowed.some((entry) => {
        const e = entry.toLowerCase().replace(/\/+$/, '');
        if (e.endsWith(':*')) {
            const base = e.slice(0, -2);
            return o === base || (o.startsWith(base + ':') && /^\d+$/.test(o.slice(base.length + 1)));
        }
        return o === e;
    });
}
