import { Readable } from 'stream';
import { IFileStorageProvider } from '../i-file-storage-provider';
import { FileEntry, FileStat } from '../models';
import { PermissionDeniedError } from '../errors';

/**
 * A storage that only reads: listing, reading, stat, exists and downloads go to `inner`; writing, creating,
 * deleting, copying and moving throw {@link PermissionDeniedError} (403 from the filesystem API). Keeps the inner
 * storage's `name`.
 */
export function readOnlyFileStorage(inner: IFileStorageProvider): IFileStorageProvider {
    const denied = async (path: string): Promise<never> => {
        throw new PermissionDeniedError(`${path} (read-only)`);
    };
    return {
        name: inner.name,
        list: (path: string): Promise<FileEntry[]> => inner.list(path),
        readFile: (path: string): Promise<string> => inner.readFile(path),
        stat: (path: string): Promise<FileStat> => inner.stat(path),
        exists: (path: string): Promise<boolean> => inner.exists(path),
        getDownloadStream: (path: string): Promise<Readable> => inner.getDownloadStream(path),
        writeFile: (path: string) => denied(path),
        mkdir: (path: string) => denied(path),
        remove: (path: string) => denied(path),
        copy: (_src: string, dest: string) => denied(dest),
        move: (src: string) => denied(src),
        uploadFile: (path: string) => denied(path),
    };
}
