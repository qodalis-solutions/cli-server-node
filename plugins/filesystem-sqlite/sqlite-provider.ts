import * as nodePath from 'path';
import * as fs from 'fs';
import { Readable } from 'stream';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import {
    IFileStorageProvider,
    FileEntry,
    FileStat,
    FileNotFoundError,
    FileExistsError,
    NotADirectoryError,
    IsADirectoryError,
} from '@qodalis/cli-server-plugin-filesystem';

export interface SqliteProviderOptions {
    dbPath: string; // e.g. './data/files.db' or ':memory:'
}

export class SqliteFileStorageProvider implements IFileStorageProvider {
    readonly name = 'sqlite';

    private db: DatabaseType;

    constructor(options: SqliteProviderOptions) {
        const dbPath = options.dbPath;

        if (dbPath !== ':memory:') {
            const dir = nodePath.dirname(nodePath.resolve(dbPath));
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.initSchema();
        this.ensureRoot();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('file', 'directory')),
                content TEXT,
                size INTEGER NOT NULL DEFAULT 0,
                permissions TEXT DEFAULT '644',
                created_at TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                parent_path TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_path);
        `);
    }

    private ensureRoot(): void {
        const root = this.db.prepare('SELECT 1 FROM files WHERE path = ?').get('/');
        if (!root) {
            const now = new Date().toISOString();
            this.db.prepare(
                `INSERT INTO files (path, name, type, size, permissions, created_at, modified_at, parent_path)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run('/', '', 'directory', 0, '755', now, now, null);
        }
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

    private getParentPath(p: string): string {
        if (p === '/') return '/';
        const lastSlash = p.lastIndexOf('/');
        return p.substring(0, lastSlash) || '/';
    }

    private getBaseName(p: string): string {
        if (p === '/') return '';
        const lastSlash = p.lastIndexOf('/');
        return p.substring(lastSlash + 1);
    }

    private getRow(path: string): FileRow | undefined {
        return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
    }

    async list(path: string): Promise<FileEntry[]> {
        const normalized = this.normalizePath(path);
        const node = this.getRow(normalized);

        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        if (node.type !== 'directory') {
            throw new NotADirectoryError(normalized);
        }

        const rows = this.db.prepare(
            'SELECT name, type, size, modified_at, permissions FROM files WHERE parent_path = ? ORDER BY name'
        ).all(normalized) as FileRow[];

        return rows.map((r) => ({
            name: r.name,
            type: r.type as 'file' | 'directory',
            size: r.size,
            modified: r.modified_at,
            permissions: r.permissions,
        }));
    }

    async readFile(path: string): Promise<string> {
        const normalized = this.normalizePath(path);
        const node = this.getRow(normalized);

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
        const parentPath = this.getParentPath(normalized);
        const name = this.getBaseName(normalized);

        const parent = this.getRow(parentPath);
        if (!parent) {
            throw new FileNotFoundError(parentPath);
        }

        if (parent.type !== 'directory') {
            throw new NotADirectoryError(parentPath);
        }

        const existing = this.getRow(normalized);
        if (existing && existing.type === 'directory') {
            throw new IsADirectoryError(normalized);
        }

        const contentStr = typeof content === 'string' ? content : content.toString('utf-8');
        const size = Buffer.byteLength(contentStr, 'utf-8');
        const now = new Date().toISOString();

        if (existing) {
            this.db.prepare(
                'UPDATE files SET content = ?, size = ?, modified_at = ? WHERE path = ?'
            ).run(contentStr, size, now, normalized);
        } else {
            this.db.prepare(
                `INSERT INTO files (path, name, type, content, size, permissions, created_at, modified_at, parent_path)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(normalized, name, 'file', contentStr, size, '644', now, now, parentPath);
        }
    }

    async stat(path: string): Promise<FileStat> {
        const normalized = this.normalizePath(path);
        const node = this.getRow(normalized);

        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        return {
            name: node.name,
            type: node.type as 'file' | 'directory',
            size: node.size,
            created: node.created_at,
            modified: node.modified_at,
            permissions: node.permissions,
        };
    }

    async mkdir(path: string, recursive: boolean = false): Promise<void> {
        const normalized = this.normalizePath(path);

        if (recursive) {
            const parts = normalized.split('/').filter(Boolean);
            let currentPath = '';

            for (const part of parts) {
                const parentPath = currentPath || '/';
                currentPath = currentPath + '/' + part;

                const existing = this.getRow(currentPath);
                if (existing) {
                    if (existing.type !== 'directory') {
                        throw new NotADirectoryError(currentPath);
                    }
                    continue;
                }

                const now = new Date().toISOString();
                this.db.prepare(
                    `INSERT INTO files (path, name, type, size, permissions, created_at, modified_at, parent_path)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(currentPath, part, 'directory', 0, '755', now, now, parentPath);
            }
        } else {
            const parentPath = this.getParentPath(normalized);
            const name = this.getBaseName(normalized);

            const parent = this.getRow(parentPath);
            if (!parent) {
                throw new FileNotFoundError(parentPath);
            }

            if (parent.type !== 'directory') {
                throw new NotADirectoryError(parentPath);
            }

            const existing = this.getRow(normalized);
            if (existing) {
                throw new FileExistsError(normalized);
            }

            const now = new Date().toISOString();
            this.db.prepare(
                `INSERT INTO files (path, name, type, size, permissions, created_at, modified_at, parent_path)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(normalized, name, 'directory', 0, '755', now, now, parentPath);
        }
    }

    async remove(path: string, recursive: boolean = false): Promise<void> {
        const normalized = this.normalizePath(path);
        const node = this.getRow(normalized);

        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        if (node.type === 'directory' && !recursive) {
            throw new IsADirectoryError(normalized);
        }

        if (recursive) {
            // Delete the path itself and all children
            this.db.prepare(
                "DELETE FROM files WHERE path = ? OR path LIKE ? || '/%'"
            ).run(normalized, normalized);
        } else {
            this.db.prepare('DELETE FROM files WHERE path = ?').run(normalized);
        }
    }

    async copy(src: string, dest: string): Promise<void> {
        const normalizedSrc = this.normalizePath(src);
        const normalizedDest = this.normalizePath(dest);

        const srcNode = this.getRow(normalizedSrc);
        if (!srcNode) {
            throw new FileNotFoundError(normalizedSrc);
        }

        const destParentPath = this.getParentPath(normalizedDest);
        const destParent = this.getRow(destParentPath);

        if (!destParent) {
            throw new FileNotFoundError(destParentPath);
        }

        if (destParent.type !== 'directory') {
            throw new NotADirectoryError(destParentPath);
        }

        const destName = this.getBaseName(normalizedDest);
        const now = new Date().toISOString();

        // Use a transaction for atomicity
        const copyTransaction = this.db.transaction(() => {
            // Remove existing destination if any
            this.db.prepare(
                "DELETE FROM files WHERE path = ? OR path LIKE ? || '/%'"
            ).run(normalizedDest, normalizedDest);

            // Copy the source node
            this.db.prepare(
                `INSERT INTO files (path, name, type, content, size, permissions, created_at, modified_at, parent_path)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(normalizedDest, destName, srcNode.type, srcNode.content, srcNode.size, srcNode.permissions, now, now, destParentPath);

            // If it's a directory, copy all children
            if (srcNode.type === 'directory') {
                const children = this.db.prepare(
                    "SELECT * FROM files WHERE path LIKE ? || '/%'"
                ).all(normalizedSrc) as FileRow[];

                for (const child of children) {
                    const relativePath = child.path.substring(normalizedSrc.length);
                    const newPath = normalizedDest + relativePath;
                    const newParentPath = this.getParentPath(newPath);

                    this.db.prepare(
                        `INSERT INTO files (path, name, type, content, size, permissions, created_at, modified_at, parent_path)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(newPath, child.name, child.type, child.content, child.size, child.permissions, now, now, newParentPath);
                }
            }
        });

        copyTransaction();
    }

    async move(src: string, dest: string): Promise<void> {
        const normalizedSrc = this.normalizePath(src);
        const normalizedDest = this.normalizePath(dest);

        const srcNode = this.getRow(normalizedSrc);
        if (!srcNode) {
            throw new FileNotFoundError(normalizedSrc);
        }

        const destParentPath = this.getParentPath(normalizedDest);
        const destParent = this.getRow(destParentPath);

        if (!destParent) {
            throw new FileNotFoundError(destParentPath);
        }

        if (destParent.type !== 'directory') {
            throw new NotADirectoryError(destParentPath);
        }

        const destName = this.getBaseName(normalizedDest);

        const moveTransaction = this.db.transaction(() => {
            // Remove existing destination if any
            this.db.prepare(
                "DELETE FROM files WHERE path = ? OR path LIKE ? || '/%'"
            ).run(normalizedDest, normalizedDest);

            // Update the source node path
            this.db.prepare(
                'UPDATE files SET path = ?, name = ?, parent_path = ? WHERE path = ?'
            ).run(normalizedDest, destName, destParentPath, normalizedSrc);

            // Update all children paths
            if (srcNode.type === 'directory') {
                const children = this.db.prepare(
                    "SELECT path FROM files WHERE path LIKE ? || '/%'"
                ).all(normalizedSrc) as { path: string }[];

                for (const child of children) {
                    const relativePath = child.path.substring(normalizedSrc.length);
                    const newPath = normalizedDest + relativePath;
                    const newParentPath = this.getParentPath(newPath);

                    this.db.prepare(
                        'UPDATE files SET path = ?, parent_path = ? WHERE path = ?'
                    ).run(newPath, newParentPath, child.path);
                }
            }
        });

        moveTransaction();
    }

    async exists(path: string): Promise<boolean> {
        const normalized = this.normalizePath(path);
        const row = this.db.prepare('SELECT 1 FROM files WHERE path = ?').get(normalized);
        return row !== undefined;
    }

    async getDownloadStream(path: string): Promise<Readable> {
        const normalized = this.normalizePath(path);
        const node = this.getRow(normalized);

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

interface FileRow {
    id: number;
    path: string;
    name: string;
    type: string;
    content: string | null;
    size: number;
    permissions: string;
    created_at: string;
    modified_at: string;
    parent_path: string | null;
}
