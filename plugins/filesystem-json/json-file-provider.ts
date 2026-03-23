import * as fs from 'fs';
import * as nodePath from 'path';
import { Readable } from 'stream';
import {
    IFileStorageProvider,
    FileEntry,
    FileStat,
    FileNotFoundError,
    FileExistsError,
    NotADirectoryError,
    IsADirectoryError,
} from '@qodalis/cli-server-plugin-filesystem';

/** Configuration for the JSON-backed file storage provider. */
export interface JsonFileProviderOptions {
    /** Path to the JSON file that persists the virtual filesystem tree. */
    filePath: string;
}

interface FileNode {
    name: string;
    type: 'file' | 'directory';
    content?: string;
    children?: FileNode[];
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
        children: [],
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

/**
 * File storage provider that persists a virtual filesystem tree to a single JSON file.
 * The entire tree is loaded on construction and flushed to disk after every mutation.
 */
export class JsonFileStorageProvider implements IFileStorageProvider {
    readonly name = 'json-file';

    private root: FileNode;
    private readonly filePath: string;

    constructor(options: JsonFileProviderOptions) {
        this.filePath = nodePath.resolve(options.filePath);
        this.root = this.load();
    }

    private load(): FileNode {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const data = JSON.parse(raw);
                return data.root ?? createDirNode('');
            }
        } catch {
            // If file is corrupt or unreadable, start fresh
        }
        return createDirNode('');
    }

    private save(): void {
        const dir = nodePath.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.filePath, JSON.stringify({ root: this.root }, null, 2), 'utf-8');
    }

    private normalizePath(p: string): string {
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

    private findChild(node: FileNode, name: string): FileNode | undefined {
        if (!node.children) return undefined;
        return node.children.find((c) => c.name === name);
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
            const child = this.findChild(current, part);
            if (!child) {
                return undefined;
            }
            current = child;
        }

        return current;
    }

    private addChild(parent: FileNode, child: FileNode): void {
        if (!parent.children) {
            parent.children = [];
        }
        parent.children.push(child);
    }

    private removeChild(parent: FileNode, name: string): void {
        if (!parent.children) return;
        parent.children = parent.children.filter((c) => c.name !== name);
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
            clone.children = node.children.map((c) => this.cloneNode(c));
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
            for (const child of node.children) {
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
        const existing = this.findChild(parent, name);

        if (existing) {
            if (existing.type === 'directory') {
                throw new IsADirectoryError(normalized);
            }
            existing.content = contentStr;
            existing.size = Buffer.byteLength(contentStr, 'utf-8');
            existing.modifiedAt = new Date().toISOString();
        } else {
            this.addChild(parent, createFileNode(name, contentStr));
        }

        this.save();
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

                let child = this.findChild(current, part);
                if (!child) {
                    child = createDirNode(part);
                    this.addChild(current, child);
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

            if (this.findChild(parent, name)) {
                throw new FileExistsError(normalized);
            }

            this.addChild(parent, createDirNode(name));
        }

        this.save();
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
            this.removeChild(parent, name);
        }

        this.save();
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

        // Replace existing child with same name, or add new
        this.removeChild(destParent, name);
        this.addChild(destParent, cloned);

        this.save();
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
