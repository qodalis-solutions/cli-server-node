import { Readable } from 'stream';
import { FileEntry, FileStat } from './models';

export interface IFileStorageProvider {
    readonly name: string;

    list(path: string): Promise<FileEntry[]>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string | Buffer): Promise<void>;
    stat(path: string): Promise<FileStat>;
    mkdir(path: string, recursive?: boolean): Promise<void>;
    remove(path: string, recursive?: boolean): Promise<void>;
    copy(src: string, dest: string): Promise<void>;
    move(src: string, dest: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    getDownloadStream(path: string): Promise<Readable>;
    uploadFile(path: string, content: Buffer): Promise<void>;
}
