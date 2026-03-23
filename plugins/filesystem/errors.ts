/** Thrown when a requested file or directory does not exist. */
export class FileNotFoundError extends Error {
    constructor(path: string) {
        super(`Path not found: ${path}`);
        this.name = 'FileNotFoundError';
    }
}

/** Thrown when a path is outside the allowed directories. */
export class PermissionDeniedError extends Error {
    constructor(path: string) {
        super(`Access denied: ${path}`);
        this.name = 'PermissionDeniedError';
    }
}

/** Thrown when creating a file or directory that already exists. */
export class FileExistsError extends Error {
    constructor(path: string) {
        super(`Path already exists: ${path}`);
        this.name = 'FileExistsError';
    }
}

/** Thrown when a file operation targets a path that is not a directory. */
export class NotADirectoryError extends Error {
    constructor(path: string) {
        super(`Not a directory: ${path}`);
        this.name = 'NotADirectoryError';
    }
}

/** Thrown when a file operation (e.g. readFile) targets a directory instead of a file. */
export class IsADirectoryError extends Error {
    constructor(path: string) {
        super(`Is a directory: ${path}`);
        this.name = 'IsADirectoryError';
    }
}
