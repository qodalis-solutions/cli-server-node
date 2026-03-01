import * as path from 'path';
import * as fs from 'fs';
import { FileSystemOptions } from './filesystem-options';

/**
 * Validates that requested filesystem paths fall within the configured
 * allowed directories. Blocks path-traversal attempts and resolves symlinks.
 */
export class FileSystemPathValidator {
    private readonly allowedPaths: string[];

    constructor(options: FileSystemOptions) {
        this.allowedPaths = options.allowedPaths.map((p) => path.resolve(p));
    }

    /**
     * Returns `true` when `requestedPath` resolves to a location inside one
     * of the allowed directories.
     */
    isPathAllowed(requestedPath: string): boolean {
        const resolved = path.resolve(requestedPath);

        // Block explicit traversal in the normalised path
        if (resolved.includes('..')) {
            return false;
        }

        // Attempt to resolve symlinks so a link outside allowed dirs is caught
        let realPath: string;
        try {
            realPath = fs.realpathSync(resolved);
        } catch {
            // Path does not exist yet (e.g. mkdir/upload target) — fall back
            // to the normalised form which is safe enough for the check.
            realPath = resolved;
        }

        return this.allowedPaths.some(
            (allowed) =>
                realPath === allowed || realPath.startsWith(allowed + path.sep),
        );
    }
}
