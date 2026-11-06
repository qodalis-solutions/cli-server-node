import type { IFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { CliEventPermissions, ICliEventBus } from '@qodalis/cli-server-abstractions';

/** `fs:changed` actions, by the provider method that performs them. */
const ACTIONS: Partial<Record<keyof IFileStorageProvider, string>> = {
    uploadFile: 'upload',
    mkdir: 'mkdir',
    remove: 'delete',
    writeFile: 'write',
    move: 'move',
    copy: 'copy',
};

/**
 * Wraps a file storage provider so every successful write publishes `fs:changed`
 * (audience `files:read`): `{ action, path }`, plus `newPath` for move and copy.
 * The filesystem API and the MCP `fs_*` tools share the wrapped provider, so both
 * publish; other members pass through unchanged.
 */
export function withFileStorageEvents<T extends IFileStorageProvider>(provider: T, eventBus: ICliEventBus): T {
    return new Proxy(provider, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;
            const action = typeof prop === 'string' ? ACTIONS[prop as keyof IFileStorageProvider] : undefined;
            if (!action) return value.bind(target);
            return async (...args: unknown[]) => {
                const result = await value.apply(target, args);
                const [path, newPath] = args;
                await eventBus.publish(
                    'fs:changed',
                    { action, path, ...(action === 'move' || action === 'copy' ? { newPath } : {}) },
                    { permission: CliEventPermissions.FilesRead },
                );
                return result;
            };
        },
    });
}
