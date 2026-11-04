/**
 * External authentication for the admin dashboard — implemented by the users
 * plugin (`usersPlugin.serverAuth`). When set, the dashboard logs in through
 * it and requires the `admin:access` permission; the static admin
 * credentials are not used.
 */
export interface AdminAuthProvider {
    login(
        username: string,
        password: string,
        metadata?: { remoteAddress?: string; userAgent?: string },
    ): Promise<{ token: string; userName: string; permissions: string[]; expiresAt: number; mustChangePassword?: boolean }>;
    authenticateToken(token: string): Promise<{ userName: string; permissions: string[]; mustChangePassword?: boolean; loginTime?: number }>;
    logout?(token: string): Promise<void>;
    /**
     * Authenticates a whole request (session token or, with an external auth adapter,
     * the host application's own session). Used in external sign-in mode, where the
     * dashboard sends the host's bearer token.
     */
    authenticateRequest?(req: import('express').Request): Promise<{ userName: string; permissions: string[] }>;
    hasPermission(ctx: { permissions: string[] }, permission: string): boolean;
}

export const ADMIN_ACCESS_PERMISSION = 'admin:access';

/** Status of an error thrown by the provider (defaults to 401). */
export function errorStatus(err: unknown): number {
    const status = (err as { status?: unknown })?.status;
    return typeof status === 'number' ? status : 401;
}

export function errorMessage(err: unknown, fallback: string): string {
    const message = (err as { message?: unknown })?.message;
    return typeof message === 'string' && message ? message : fallback;
}
