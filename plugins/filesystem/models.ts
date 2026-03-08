export interface FileEntry {
    name: string;
    type: 'file' | 'directory';
    size: number;
    modified: string;
    permissions?: string;
}

export interface FileStat {
    name: string;
    type: 'file' | 'directory';
    size: number;
    created: string;
    modified: string;
    permissions?: string;
}
