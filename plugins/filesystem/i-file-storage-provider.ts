import { Readable } from 'stream';
import { FileEntry, FileStat } from './models';

/**
 * Abstraction over file storage backends (in-memory, OS, SQLite, S3, etc.).
 * All paths are virtual and provider-specific.
 */
export interface IFileStorageProvider {
    /** Human-readable provider name (e.g. 'in-memory', 'os', 's3'). */
    readonly name: string;

    /** List entries in a directory. */
    list(path: string): Promise<FileEntry[]>;
    /** Read a file's contents as a UTF-8 string. */
    readFile(path: string): Promise<string>;
    /** Write (create or overwrite) a file. */
    writeFile(path: string, content: string | Buffer): Promise<void>;
    /** Return metadata for a file or directory. */
    stat(path: string): Promise<FileStat>;
    /** Create a directory, optionally creating intermediate parents. */
    mkdir(path: string, recursive?: boolean): Promise<void>;
    /** Remove a file or directory (recursive required for non-empty directories). */
    remove(path: string, recursive?: boolean): Promise<void>;
    /** Copy a file or directory tree from `src` to `dest`. */
    copy(src: string, dest: string): Promise<void>;
    /** Move (rename) a file or directory from `src` to `dest`. */
    move(src: string, dest: string): Promise<void>;
    /** Check whether a path exists. */
    exists(path: string): Promise<boolean>;
    /** Return a readable stream for downloading a file. */
    getDownloadStream(path: string): Promise<Readable>;
    /** Upload raw bytes to a file path. */
    uploadFile(path: string, content: Buffer): Promise<void>;
}
