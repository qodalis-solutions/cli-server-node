/** Describes a single entry returned by a directory listing. */
export interface FileEntry {
    name: string;
    type: 'file' | 'directory';
    size: number;
    modified: string;
    permissions?: string;
}

/** Detailed metadata for a file or directory. */
export interface FileStat {
    name: string;
    type: 'file' | 'directory';
    size: number;
    created: string;
    modified: string;
    permissions?: string;
}
