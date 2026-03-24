/** Configuration for the filesystem API access control. */
export interface FileSystemOptions {
    /** Absolute paths that the filesystem API is allowed to access. */
    allowedPaths: string[];
}
