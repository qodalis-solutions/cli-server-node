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
import { CLI_INSTALLED_PLUGIN } from '@qodalis/cli-server-plugin-filesystem';
import { filesystemSqliteInstalledPlugin } from './package-info';
import { qcliTableName, type CliTableNameOptions } from '@qodalis/cli-server-abstractions';
import {
    CliMigrationRunner,
    adoptLegacyTable,
    codeSource,
    sqliteConnection,
    tableExists,
    type CliMigrationSource,
    type CliSqlConnection,
} from '@qodalis/cli-server-plugin-databases';

/** Configuration for the SQLite-backed file storage provider. */
export interface SqliteProviderOptions extends Pick<CliTableNameOptions, 'tablePrefix' | 'legacyTableNames'> {
    /** Path to the SQLite database file, or ':memory:' for in-memory operation. */
    dbPath: string;
    /** The table's name (default `QcliFiles`; the prefix and per-table override follow the plugin table names). */
    tables?: { Files?: string };
}

/** The columns of a previous release (`files`), renamed by the first migration. */
/**
 * The row as the provider reads it: SQLite matches the columns case-insensitively but names results as declared,
 * so every column is aliased.
 */
const ROW_COLUMNS_OF = (c: Columns) =>
    `id AS id, path AS path, name AS name, type AS type, content AS content, size AS size, permissions AS permissions, "${c.CreatedAt}" AS created_at, "${c.ModifiedAt}" AS modified_at, "${c.ParentPath}" AS parent_path`;

const LEGACY_COLUMNS = {
    id: 'Id',
    path: 'Path',
    name: 'Name',
    type: 'Type',
    content: 'Content',
    size: 'Size',
    permissions: 'Permissions',
    created_at: 'CreatedAt',
    modified_at: 'ModifiedAt',
    parent_path: 'ParentPath',
} as const;

type Columns = { CreatedAt: string; ModifiedAt: string; ParentPath: string };

/** The schema of the files table as migrations (source `qcli-filesystem`); `table` is unquoted. */
export function filesystemSqliteMigrations(table: string, legacy = false): CliMigrationSource {
    return codeSource('qcli-filesystem', [
        {
            id: '1',
            name: 'files table',
            up: async (db) => {
                if (!legacy) await adoptLegacyTable(db, 'files', table, LEGACY_COLUMNS);
                if (await tableExists(db, table)) return;
                const [created, modified, parent] = legacy ? ['created_at', 'modified_at', 'parent_path'] : ['CreatedAt', 'ModifiedAt', 'ParentPath'];
                const col = (n: string) => (legacy ? n.toLowerCase() : n);
                await db.exec(`CREATE TABLE "${table}" (
                    "${col('Id')}" INTEGER PRIMARY KEY AUTOINCREMENT,
                    "${col('Path')}" TEXT NOT NULL UNIQUE,
                    "${col('Name')}" TEXT NOT NULL,
                    "${col('Type')}" TEXT NOT NULL CHECK("${col('Type')}" IN ('file', 'directory')),
                    "${col('Content')}" TEXT,
                    "${col('Size')}" INTEGER NOT NULL DEFAULT 0,
                    "${col('Permissions')}" TEXT DEFAULT '644',
                    "${created}" TEXT NOT NULL,
                    "${modified}" TEXT NOT NULL,
                    "${parent}" TEXT
                )`);
            },
        },
        {
            id: '2',
            name: 'index on the parent path',
            up: async (db) => {
                const parent = legacy ? 'parent_path' : 'ParentPath';
                if (!legacy) await db.exec('DROP INDEX IF EXISTS "idx_files_parent"');
                await db.exec(`CREATE INDEX IF NOT EXISTS "${legacy ? 'idx_files_parent' : `IX_${table}_ParentPath`}" ON "${table}" ("${parent}")`);
            },
        },
    ]);
}

/**
 * File storage provider that persists a virtual filesystem in a SQLite database.
 * Uses WAL journaling for concurrent read performance.
 */
export class SqliteFileStorageProvider implements IFileStorageProvider {
    /** The package this class belongs to, listed among the server's installed plugins. */
    static readonly [CLI_INSTALLED_PLUGIN] = filesystemSqliteInstalledPlugin;

    readonly name = 'sqlite';

    private db: DatabaseType;
    /** The files table, quoted. */
    private readonly table: string;
    private readonly c: Columns;
    /** Resolves once the schema is migrated and the root exists; every operation waits for it. */
    readonly ready: Promise<void>;
    /** The database, for the databases plugin (`addDatabase('files', { connection })`). */
    readonly connection: CliSqlConnection;
    /** The files table's migrations (`qcli-filesystem`), to show them in the databases plugin. */
    readonly migrationSource: CliMigrationSource;

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
        const legacy = options.legacyTableNames === true;
        const name = qcliTableName('Files', { tablePrefix: options.tablePrefix, tables: options.tables, legacyTableNames: legacy }, 'files');
        this.table = `"${name}"`;
        this.c = legacy
            ? { CreatedAt: 'created_at', ModifiedAt: 'modified_at', ParentPath: 'parent_path' }
            : { CreatedAt: 'CreatedAt', ModifiedAt: 'ModifiedAt', ParentPath: 'ParentPath' };
        this.connection = sqliteConnection(this.db);
        this.migrationSource = filesystemSqliteMigrations(name, legacy);
        // The schema is versioned: the first start after an upgrade renames `files` and its columns, keeping the data
        const runner = new CliMigrationRunner('files', { connection: this.connection, tablePrefix: options.tablePrefix }).addSource(this.migrationSource);
        this.ready = runner.up({ trigger: 'startup', wait: true }).then((run) => {
            if ('status' in run && run.status === 'failed') throw new Error(`filesystem-sqlite schema: ${run.error}`);
            this.ensureRoot();
        });
        // A failed migration rejects every operation that awaits `ready`; until one does, it must not crash the process
        this.ready.catch(() => undefined);
    }

    private ensureRoot(): void {
        const root = this.db.prepare(`SELECT 1 FROM ${this.table} WHERE path = ?`).get('/');
        if (!root) {
            const now = new Date().toISOString();
            this.db.prepare(
                `INSERT INTO ${this.table} (path, name, type, size, permissions, ${this.c.CreatedAt}, ${this.c.ModifiedAt}, ${this.c.ParentPath})
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
        return this.db.prepare(`SELECT ${ROW_COLUMNS_OF(this.c)} FROM ${this.table} WHERE path = ?`).get(path) as FileRow | undefined;
    }

    async list(path: string): Promise<FileEntry[]> {
        await this.ready;
        const normalized = this.normalizePath(path);
        const node = this.getRow(normalized);

        if (!node) {
            throw new FileNotFoundError(normalized);
        }

        if (node.type !== 'directory') {
            throw new NotADirectoryError(normalized);
        }

        const rows = this.db.prepare(
            `SELECT name AS name, type AS type, size AS size, ${this.c.ModifiedAt} AS modified_at, permissions AS permissions FROM ${this.table} WHERE ${this.c.ParentPath} = ? ORDER BY name`
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
        await this.ready;
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
        await this.ready;
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
                `UPDATE ${this.table} SET content = ?, size = ?, ${this.c.ModifiedAt} = ? WHERE path = ?`
            ).run(contentStr, size, now, normalized);
        } else {
            this.db.prepare(
                `INSERT INTO ${this.table} (path, name, type, content, size, permissions, ${this.c.CreatedAt}, ${this.c.ModifiedAt}, ${this.c.ParentPath})
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(normalized, name, 'file', contentStr, size, '644', now, now, parentPath);
        }
    }

    async stat(path: string): Promise<FileStat> {
        await this.ready;
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
        await this.ready;
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
                    `INSERT INTO ${this.table} (path, name, type, size, permissions, ${this.c.CreatedAt}, ${this.c.ModifiedAt}, ${this.c.ParentPath})
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
                `INSERT INTO ${this.table} (path, name, type, size, permissions, ${this.c.CreatedAt}, ${this.c.ModifiedAt}, ${this.c.ParentPath})
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(normalized, name, 'directory', 0, '755', now, now, parentPath);
        }
    }

    async remove(path: string, recursive: boolean = false): Promise<void> {
        await this.ready;
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
                `DELETE FROM ${this.table} WHERE path = ? OR path LIKE ? || '/%'`
            ).run(normalized, normalized);
        } else {
            this.db.prepare(`DELETE FROM ${this.table} WHERE path = ?`).run(normalized);
        }
    }

    async copy(src: string, dest: string): Promise<void> {
        await this.ready;
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
                `DELETE FROM ${this.table} WHERE path = ? OR path LIKE ? || '/%'`
            ).run(normalizedDest, normalizedDest);

            // Copy the source node
            this.db.prepare(
                `INSERT INTO ${this.table} (path, name, type, content, size, permissions, ${this.c.CreatedAt}, ${this.c.ModifiedAt}, ${this.c.ParentPath})
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(normalizedDest, destName, srcNode.type, srcNode.content, srcNode.size, srcNode.permissions, now, now, destParentPath);

            // If it's a directory, copy all children
            if (srcNode.type === 'directory') {
                const children = this.db.prepare(
                    `SELECT ${ROW_COLUMNS_OF(this.c)} FROM ${this.table} WHERE path LIKE ? || '/%'`
                ).all(normalizedSrc) as FileRow[];

                for (const child of children) {
                    const relativePath = child.path.substring(normalizedSrc.length);
                    const newPath = normalizedDest + relativePath;
                    const newParentPath = this.getParentPath(newPath);

                    this.db.prepare(
                        `INSERT INTO ${this.table} (path, name, type, content, size, permissions, ${this.c.CreatedAt}, ${this.c.ModifiedAt}, ${this.c.ParentPath})
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(newPath, child.name, child.type, child.content, child.size, child.permissions, now, now, newParentPath);
                }
            }
        });

        copyTransaction();
    }

    async move(src: string, dest: string): Promise<void> {
        await this.ready;
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
                `DELETE FROM ${this.table} WHERE path = ? OR path LIKE ? || '/%'`
            ).run(normalizedDest, normalizedDest);

            // Update the source node path
            this.db.prepare(
                `UPDATE ${this.table} SET path = ?, name = ?, ${this.c.ParentPath} = ? WHERE path = ?`
            ).run(normalizedDest, destName, destParentPath, normalizedSrc);

            // Update all children paths
            if (srcNode.type === 'directory') {
                const children = this.db.prepare(
                    `SELECT path AS path FROM ${this.table} WHERE path LIKE ? || '/%'`
                ).all(normalizedSrc) as { path: string }[];

                for (const child of children) {
                    const relativePath = child.path.substring(normalizedSrc.length);
                    const newPath = normalizedDest + relativePath;
                    const newParentPath = this.getParentPath(newPath);

                    this.db.prepare(
                        `UPDATE ${this.table} SET path = ?, ${this.c.ParentPath} = ? WHERE path = ?`
                    ).run(newPath, newParentPath, child.path);
                }
            }
        });

        moveTransaction();
    }

    async exists(path: string): Promise<boolean> {
        await this.ready;
        const normalized = this.normalizePath(path);
        const row = this.db.prepare(`SELECT 1 FROM ${this.table} WHERE path = ?`).get(normalized);
        return row !== undefined;
    }

    async getDownloadStream(path: string): Promise<Readable> {
        await this.ready;
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
        await this.ready;
        await this.writeFile(path, content);
    }
}

/** Raw row shape returned by the provider's queries (aliased to these names). */
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
