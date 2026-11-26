import { accessSync, constants, statSync } from 'fs';
import { dirname, resolve, sep } from 'path';

/** The environment variable that moves the server's data directory when `dataDir` is not given. */
export const QCLI_DATA_DIR_ENV = 'QCLI_DATA_DIR';

/** What to do about an unwritable folder below the server's data directory. */
export const DATA_DIR_HINT = `Set dataDir (or ${QCLI_DATA_DIR_ENV}) to a writable folder`;

const REASONS: Record<string, string> = {
    EACCES: 'permission denied',
    EPERM: 'operation not permitted',
    EROFS: 'read-only file system',
    ENOSPC: 'no space left on device',
    EDQUOT: 'disk quota exceeded',
    ENOENT: 'no such file or directory',
    ENOTDIR: 'not a directory',
    EISDIR: 'is a directory',
    EEXIST: 'file already exists',
    EMFILE: 'too many open files',
    EBUSY: 'resource busy or locked',
};

/** `permission denied (EACCES)`: a file system error code in words. */
export function fileSystemReason(code: string): string {
    return `${REASONS[code] ?? 'file system error'} (${code})`;
}

/** The message of an unwritable plugins folder, the same on every server. */
export function pluginsFolderMessage(folder: string, code: string, hint: string): string {
    return `cannot write the plugins folder ${folder}: ${fileSystemReason(code)}. ${hint}`;
}

/**
 * The message for a file system error on `folder`, one of its files or one of its parents (a recursive mkdir fails on
 * the first parent it cannot create); undefined for anything else (a network error, a missing `npm`), which is not
 * about the folder. Only the folder, the error code and the hint are named: never the error's own text.
 */
export function pluginsFolderError(err: unknown, folder: string, hint: string): string | undefined {
    const e = err as NodeJS.ErrnoException | undefined;
    if (!e || typeof e !== 'object' || typeof e.code !== 'string' || typeof e.syscall !== 'string' || typeof e.path !== 'string') return undefined;
    if (e.syscall.startsWith('spawn')) return undefined;
    const path = resolve(e.path);
    const root = resolve(folder);
    const inside = path === root || path.startsWith(root + sep) || root.startsWith(path + sep);
    return inside ? pluginsFolderMessage(root, e.code, hint) : undefined;
}

/**
 * Why `folder` cannot be created or written, without creating it: the error code of the folder, or of its nearest
 * existing parent when it does not exist yet; undefined when it can be.
 */
export function unwritableFolderCode(folder: string): string | undefined {
    let path = resolve(folder);
    for (;;) {
        try {
            if (!statSync(path).isDirectory()) return 'ENOTDIR';
            accessSync(path, constants.W_OK | constants.X_OK);
            return undefined;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code ?? 'EACCES';
            if (code !== 'ENOENT') return code;
            const parent = dirname(path);
            if (parent === path) return 'ENOENT';
            path = parent;
        }
    }
}

/**
 * The startup WARNING for the marketplace folders that cannot be created or written (one line, undefined when every
 * folder is fine): installing, updating and removing plugins would fail with 500.
 */
export function unwritableFoldersWarning(folders: ReadonlyArray<{ dir: string; hint: string }>): string | undefined {
    const bad = folders.map((f) => ({ ...f, code: unwritableFolderCode(f.dir) })).filter((f) => f.code);
    if (bad.length === 0) return undefined;
    const hints = [...new Set(bad.map((f) => f.hint))].join('; ');
    const list = bad.map((f) => `${resolve(f.dir)}: ${fileSystemReason(f.code!)}`).join('; ');
    return `[qcli-admin] WARNING: the marketplace cannot write the plugins folder${bad.length > 1 ? 's' : ''} ${list}. Installing, updating and removing plugins will fail. ${hints}.`;
}
