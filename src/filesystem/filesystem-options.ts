/** Default largest accepted upload: 100 MiB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Options of the filesystem HTTP API (`/api/qcli/fs`). */
export interface FileSystemApiOptions {
    /**
     * Largest file accepted by `POST /upload`, in bytes (default 100 MiB,
     * {@link DEFAULT_MAX_UPLOAD_BYTES}). Larger uploads are refused with `413`.
     */
    maxUploadBytes?: number;
}

/** Configuration for the filesystem API access control. */
export interface FileSystemOptions extends FileSystemApiOptions {
    /** Absolute paths that the filesystem API is allowed to access. */
    allowedPaths: string[];
}
