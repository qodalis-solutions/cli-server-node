import * as fs from 'fs';
import * as nodePath from 'path';
import { Readable } from 'stream';
import { IFileStorageProvider } from '../i-file-storage-provider';
import { FileEntry, FileStat } from '../models';
import {
    FileNotFoundError,
    PermissionDeniedError,
    NotADirectoryError,
    IsADirectoryError,
} from '../errors';

export interface OsProviderOptions {
    allowedPaths: string[];
}

export class OsFileStorageProvider implements IFileStorageProvider {
    readonly name = 'os';
    private readonly allowedPaths: string[];

    constructor(options: OsProviderOptions) {
        this.allowedPaths = options.allowedPaths.map((p) => nodePath.resolve(p));
    }

    private validate(requestedPath: string): string {
        const resolved = nodePath.resolve(requestedPath);
        if (resolved.includes('..')) {
            throw new PermissionDeniedError(requestedPath);
        }

        let realPath: string;
        try {
            realPath = fs.realpathSync(resolved);
        } catch {
            // Path may not exist yet (e.g. for write/mkdir); fall back to resolved
            realPath = resolved;
        }

        const allowed = this.allowedPaths.some(
            (ap) => realPath === ap || realPath.startsWith(ap + nodePath.sep),
        );
        if (!allowed) {
            throw new PermissionDeniedError(requestedPath);
        }

        return realPath;
    }

    async list(path: string): Promise<FileEntry[]> {
        const resolved = this.validate(path);

        if (!fs.existsSync(resolved)) {
            throw new FileNotFoundError(path);
        }

        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            throw new NotADirectoryError(path);
        }

        const dirents = fs.readdirSync(resolved, { withFileTypes: true });
        const entries: FileEntry[] = dirents.map((d) => {
            const fullPath = nodePath.join(resolved, d.name);
            let size = 0;
            let modified = '';
            let permissions: string | undefined;

            try {
                const s = fs.statSync(fullPath);
                size = s.size;
                modified = s.mtime.toISOString();
                permissions = (s.mode & 0o777).toString(8);
            } catch {
                // Entry may have been removed between readdir and stat
            }

            return {
                name: d.name,
                type: d.isDirectory() ? 'directory' as const : 'file' as const,
                size,
                modified,
                permissions,
            };
        });

        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    async readFile(path: string): Promise<string> {
        const resolved = this.validate(path);

        if (!fs.existsSync(resolved)) {
            throw new FileNotFoundError(path);
        }

        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
            throw new IsADirectoryError(path);
        }

        return fs.readFileSync(resolved, 'utf-8');
    }

    async writeFile(path: string, content: string | Buffer): Promise<void> {
        const resolved = this.validate(path);

        // Ensure parent directory exists
        const dir = nodePath.dirname(resolved);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (fs.existsSync(resolved)) {
            const stat = fs.statSync(resolved);
            if (stat.isDirectory()) {
                throw new IsADirectoryError(path);
            }
        }

        fs.writeFileSync(resolved, content);
    }

    async stat(path: string): Promise<FileStat> {
        const resolved = this.validate(path);

        if (!fs.existsSync(resolved)) {
            throw new FileNotFoundError(path);
        }

        const stat = fs.statSync(resolved);
        return {
            name: nodePath.basename(resolved),
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
            permissions: (stat.mode & 0o777).toString(8),
        };
    }

    async mkdir(path: string, recursive: boolean = false): Promise<void> {
        const resolved = this.validate(path);
        fs.mkdirSync(resolved, { recursive });
    }

    async remove(path: string, recursive: boolean = false): Promise<void> {
        const resolved = this.validate(path);

        if (!fs.existsSync(resolved)) {
            throw new FileNotFoundError(path);
        }

        const stat = fs.statSync(resolved);
        if (stat.isDirectory() && !recursive) {
            throw new IsADirectoryError(path);
        }

        fs.rmSync(resolved, { recursive, force: true });
    }

    async copy(src: string, dest: string): Promise<void> {
        const resolvedSrc = this.validate(src);
        const resolvedDest = this.validate(dest);

        if (!fs.existsSync(resolvedSrc)) {
            throw new FileNotFoundError(src);
        }

        fs.cpSync(resolvedSrc, resolvedDest, { recursive: true });
    }

    async move(src: string, dest: string): Promise<void> {
        const resolvedSrc = this.validate(src);
        const resolvedDest = this.validate(dest);

        if (!fs.existsSync(resolvedSrc)) {
            throw new FileNotFoundError(src);
        }

        fs.renameSync(resolvedSrc, resolvedDest);
    }

    async exists(path: string): Promise<boolean> {
        try {
            const resolved = this.validate(path);
            return fs.existsSync(resolved);
        } catch {
            return false;
        }
    }

    async getDownloadStream(path: string): Promise<Readable> {
        const resolved = this.validate(path);

        if (!fs.existsSync(resolved)) {
            throw new FileNotFoundError(path);
        }

        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
            throw new IsADirectoryError(path);
        }

        return fs.createReadStream(resolved);
    }

    async uploadFile(path: string, content: Buffer): Promise<void> {
        await this.writeFile(path, content);
    }
}
