export class FileNotFoundError extends Error {
    constructor(path: string) {
        super(`Path not found: ${path}`);
        this.name = 'FileNotFoundError';
    }
}

export class PermissionDeniedError extends Error {
    constructor(path: string) {
        super(`Access denied: ${path}`);
        this.name = 'PermissionDeniedError';
    }
}

export class FileExistsError extends Error {
    constructor(path: string) {
        super(`Path already exists: ${path}`);
        this.name = 'FileExistsError';
    }
}

export class NotADirectoryError extends Error {
    constructor(path: string) {
        super(`Not a directory: ${path}`);
        this.name = 'NotADirectoryError';
    }
}

export class IsADirectoryError extends Error {
    constructor(path: string) {
        super(`Is a directory: ${path}`);
        this.name = 'IsADirectoryError';
    }
}
