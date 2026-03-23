import { Readable } from 'stream';
import { IFileStorageProvider } from '../i-file-storage-provider';
import { FileEntry, FileStat } from '../models';
import {
    FileNotFoundError,
    IsADirectoryError,
    NotADirectoryError,
    FileExistsError,
} from '../errors';

interface FileNode {
    name: string;
    type: 'file' | 'directory';
    content?: string;
    children?: Map<string, FileNode>;
    createdAt: string;
    modifiedAt: string;
    size: number;
    permissions: string;
}

function createDirNode(name: string): FileNode {
    const now = new Date().toISOString();
    return {
        name,
        type: 'directory',
        children: new Map(),
        createdAt: now,
        modifiedAt: now,
        size: 0,
        permissions: '755',
    };
}

function createFileNode(name: string, content: string): FileNode {
    const now = new Date().toISOString();
    return {
        name,
        type: 'file',
        content,
        createdAt: now,
        modifiedAt: now,
        size: Buffer.byteLength(content, 'utf-8'),
        permissions: '644',
    };
}

/** File storage provider backed by an in-memory tree structure (volatile, lost on restart). */
export class InMemoryFileStorageProvider implements IFileStorageProvider {
    readonly name = 'in-memory';

    private root: FileNode = createDirNode('');

    private normalizePath(p: string): string {
        // Remove trailing slashes, ensure leading slash, collapse multiples
        let normalized = p.replace(/\/+/g, '/').replace(/\/+$/, '');
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        if (normalized === '') {
            normalized = '/';
        }
        return normalized;
    }

    private getParentAndName(p: string): { parentPath: string; name: string } {
        const normalized = this.normalizePath(p);
        if (normalized === '/') {
            return { parentPath: '/', name: '' };
        }
        const lastSlash = normalized.lastIndexOf('/');
        const parentPath = normalized.substring(0, lastSlash) || '/';
        const name = normalized.substring(lastSlash + 1);
        return { parentPath, name };
    }

    private resolve(p: string): FileNode | undefined {
        const normalized = this.normalizePath(p);
        if (normalized === '/') {
            return this.root;
        }

        const parts = normalized.split('/').filter(Boolean);
        let current = this.root;

        for (const part of parts) {
            if (current.type !== 'directory' || !current.children) {
                return undefined;
            }
            const child = current.children.get(part);
            if (!child) {
                return undefined;
            }
            current = child;
        }

        return current;
    }

    private cloneNode(node: FileNode): FileNode {
        const clone: FileNode = {
            name: node.name,
            type: node.type,
            createdAt: node.createdAt,
            modifiedAt: node.modifiedAt,
            size: node.size,
            permissions: node.permissions,
        };

        if (node.type === 'file') {
            clone.content = node.content;
        } else if (node.children) {
            clone.children = new Map();
            for (const [key, child] of node.children) {
                clone.children.set(key, this.cloneNode(child));
            }
        }

        return clone;
    }

    async list(path: string): Promise<FileEntry[]> {
        const normalized = this.normalizePath(path);
        const node = this.resolve(normalized);

        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        if (node.type !== 'directory') {
            throw new NotADirectoryError(normalized);
        }

        const entries: FileEntry[] = [];
        if (node.children) {
            for (const child of node.children.values()) {
                entries.push({
                    name: child.name,
                    type: child.type,
                    size: child.size,
                    modified: child.modifiedAt,
                    permissions: child.permissions,
                });
            }
        }

        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    async readFile(path: string): Promise<string> {
        const normalized = this.normalizePath(path);
        const node = this.resolve(normalized);

        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        if (node.type === 'directory') {
            throw new IsADirectoryError(normalized);
        }

        return node.content ?? '';
    }

    async writeFile(path: string, content: string | Buffer): Promise<void> {
        const normalized = this.normalizePath(path);
        const { parentPath, name } = this.getParentAndName(normalized);

        const parent = this.resolve(parentPath);
        if (!parent) {
            throw new FileNotFoundError(parentPath);
        }

        if (parent.type !== 'directory') {
            throw new NotADirectoryError(parentPath);
        }

        const contentStr = typeof content === 'string' ? content : content.toString('utf-8');
        const existing = parent.children!.get(name);

        if (existing) {
            if (existing.type === 'directory') {
                throw new IsADirectoryError(normalized);
            }
            existing.content = contentStr;
            existing.size = Buffer.byteLength(contentStr, 'utf-8');
            existing.modifiedAt = new Date().toISOString();
        } else {
            parent.children!.set(name, createFileNode(name, contentStr));
        }
    }

    async stat(path: string): Promise<FileStat> {
        const normalized = this.normalizePath(path);
        const node = this.resolve(normalized);

        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        return {
            name: node.name,
            type: node.type,
            size: node.size,
            created: node.createdAt,
            modified: node.modifiedAt,
            permissions: node.permissions,
        };
    }

    async mkdir(path: string, recursive: boolean = false): Promise<void> {
        const normalized = this.normalizePath(path);

        if (recursive) {
            const parts = normalized.split('/').filter(Boolean);
            let current = this.root;

            for (const part of parts) {
                if (current.type !== 'directory') {
                    throw new NotADirectoryError(part);
                }

                let child = current.children!.get(part);
                if (!child) {
                    child = createDirNode(part);
                    current.children!.set(part, child);
                } else if (child.type !== 'directory') {
                    throw new FileExistsError(part);
                }
                current = child;
            }
        } else {
            const { parentPath, name } = this.getParentAndName(normalized);
            const parent = this.resolve(parentPath);

            if (!parent) {
                throw new FileNotFoundError(parentPath);
            }

            if (parent.type !== 'directory') {
                throw new NotADirectoryError(parentPath);
            }

            if (parent.children!.has(name)) {
                throw new FileExistsError(normalized);
            }

            parent.children!.set(name, createDirNode(name));
        }
    }

    async remove(path: string, recursive: boolean = false): Promise<void> {
        const normalized = this.normalizePath(path);
        const { parentPath, name } = this.getParentAndName(normalized);

        const node = this.resolve(normalized);
        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        if (node.type === 'directory' && !recursive) {
            throw new IsADirectoryError(normalized);
        }

        const parent = this.resolve(parentPath);
        if (parent && parent.children) {
            parent.children.delete(name);
        }
    }

    async copy(src: string, dest: string): Promise<void> {
        const normalizedSrc = this.normalizePath(src);
        const normalizedDest = this.normalizePath(dest);

        const srcNode = this.resolve(normalizedSrc);
        if (!srcNode) {
            throw new FileNotFoundError(normalizedSrc);
        }

        const { parentPath, name } = this.getParentAndName(normalizedDest);
        const destParent = this.resolve(parentPath);

        if (!destParent) {
            throw new FileNotFoundError(parentPath);
        }

        if (destParent.type !== 'directory') {
            throw new NotADirectoryError(parentPath);
        }

        const cloned = this.cloneNode(srcNode);
        cloned.name = name;
        destParent.children!.set(name, cloned);
    }

    async move(src: string, dest: string): Promise<void> {
        await this.copy(src, dest);
        await this.remove(src, true);
    }

    async exists(path: string): Promise<boolean> {
        const normalized = this.normalizePath(path);
        return this.resolve(normalized) !== undefined;
    }

    async getDownloadStream(path: string): Promise<Readable> {
        const normalized = this.normalizePath(path);
        const node = this.resolve(normalized);

        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        if (node.type === 'directory') {
            throw new IsADirectoryError(normalized);
        }

        const content = node.content ?? '';
        const buffer = Buffer.from(content, 'utf-8');
        return Readable.from(buffer);
    }

    async uploadFile(path: string, content: Buffer): Promise<void> {
        await this.writeFile(path, content);
    }
}
