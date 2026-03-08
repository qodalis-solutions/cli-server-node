import * as fs from 'fs/promises';
import * as fsSync from 'fs';
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

    private async validate(requestedPath: string): Promise<string> {
        const resolved = nodePath.resolve(requestedPath);

        let realPath: string;
        try {
            realPath = await fs.realpath(resolved);
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
        const resolved = await this.validate(path);

        let stat;
        try {
            stat = await fs.stat(resolved);
        } catch {
            throw new FileNotFoundError(path);
        }

        if (!stat.isDirectory()) {
            throw new NotADirectoryError(path);
        }

        const dirents = await fs.readdir(resolved, { withFileTypes: true });
        const entries: FileEntry[] = [];

        for (const d of dirents) {
            const fullPath = nodePath.join(resolved, d.name);
            let size = 0;
            let modified = '';
            let permissions: string | undefined;

            try {
                const s = await fs.stat(fullPath);
                size = s.size;
                modified = s.mtime.toISOString();
                permissions = (s.mode & 0o777).toString(8);
            } catch {
                // Entry may have been removed between readdir and stat
            }

            entries.push({
                name: d.name,
                type: d.isDirectory() ? 'directory' as const : 'file' as const,
                size,
                modified,
                permissions,
            });
        }

        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    async readFile(path: string): Promise<string> {
        const resolved = await this.validate(path);

        let stat;
        try {
            stat = await fs.stat(resolved);
        } catch {
            throw new FileNotFoundError(path);
        }

        if (stat.isDirectory()) {
            throw new IsADirectoryError(path);
        }

        return fs.readFile(resolved, 'utf-8');
    }

    async writeFile(path: string, content: string | Buffer): Promise<void> {
        const resolved = await this.validate(path);

        // Ensure parent directory exists
        const dir = nodePath.dirname(resolved);
        await fs.mkdir(dir, { recursive: true });

        try {
            const stat = await fs.stat(resolved);
            if (stat.isDirectory()) {
                throw new IsADirectoryError(path);
            }
        } catch (err) {
            if (err instanceof IsADirectoryError) throw err;
            // File doesn't exist yet — that's fine
        }

        await fs.writeFile(resolved, content);
    }

    async stat(path: string): Promise<FileStat> {
        const resolved = await this.validate(path);

        let stat;
        try {
            stat = await fs.stat(resolved);
        } catch {
            throw new FileNotFoundError(path);
        }

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
        const resolved = await this.validate(path);
        await fs.mkdir(resolved, { recursive });
    }

    async remove(path: string, recursive: boolean = false): Promise<void> {
        const resolved = await this.validate(path);

        let stat;
        try {
            stat = await fs.stat(resolved);
        } catch {
            throw new FileNotFoundError(path);
        }

        if (stat.isDirectory() && !recursive) {
            throw new IsADirectoryError(path);
        }

        await fs.rm(resolved, { recursive, force: true });
    }

    async copy(src: string, dest: string): Promise<void> {
        const resolvedSrc = await this.validate(src);
        const resolvedDest = await this.validate(dest);

        try {
            await fs.access(resolvedSrc);
        } catch {
            throw new FileNotFoundError(src);
        }

        await fs.cp(resolvedSrc, resolvedDest, { recursive: true });
    }

    async move(src: string, dest: string): Promise<void> {
        const resolvedSrc = await this.validate(src);
        const resolvedDest = await this.validate(dest);

        try {
            await fs.access(resolvedSrc);
        } catch {
            throw new FileNotFoundError(src);
        }

        await fs.rename(resolvedSrc, resolvedDest);
    }

    async exists(path: string): Promise<boolean> {
        try {
            const resolved = await this.validate(path);
            await fs.access(resolved);
            return true;
        } catch {
            return false;
        }
    }

    async getDownloadStream(path: string): Promise<Readable> {
        const resolved = await this.validate(path);

        let stat;
        try {
            stat = await fs.stat(resolved);
        } catch {
            throw new FileNotFoundError(path);
        }

        if (stat.isDirectory()) {
            throw new IsADirectoryError(path);
        }

        return fsSync.createReadStream(resolved);
    }

    async uploadFile(path: string, content: Buffer): Promise<void> {
        await this.writeFile(path, content);
    }
}
