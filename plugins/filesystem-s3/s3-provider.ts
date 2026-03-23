import { Readable } from 'stream';
import {
    IFileStorageProvider,
    FileEntry,
    FileStat,
    FileNotFoundError,
    IsADirectoryError,
} from '@qodalis/cli-server-plugin-filesystem';
import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    HeadObjectCommand,
    CopyObjectCommand,
} from '@aws-sdk/client-s3';

/** Configuration for the S3-backed file storage provider. */
export interface S3ProviderOptions {
    /** S3 bucket name. */
    bucket: string;
    /** AWS region (defaults to 'us-east-1'). */
    region?: string;
    /** Optional key prefix prepended to all virtual paths. */
    prefix?: string;
    /** Custom S3-compatible endpoint URL (e.g. MinIO). */
    endpoint?: string;
    /** Explicit AWS credentials; omit to use the default credential chain. */
    credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
    };
}

/**
 * File storage provider backed by Amazon S3 (or any S3-compatible service).
 * Directories are represented by zero-byte objects with a trailing `/`.
 */
export class S3FileStorageProvider implements IFileStorageProvider {
    readonly name = 's3';

    private readonly client: S3Client;
    private readonly bucket: string;
    private readonly prefix: string;

    constructor(options: S3ProviderOptions) {
        this.bucket = options.bucket;
        this.prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : '';

        this.client = new S3Client({
            region: options.region ?? 'us-east-1',
            ...(options.endpoint ? { endpoint: options.endpoint } : {}),
            ...(options.credentials
                ? {
                      credentials: {
                          accessKeyId: options.credentials.accessKeyId,
                          secretAccessKey: options.credentials.secretAccessKey,
                      },
                  }
                : {}),
        });
    }

    /**
     * Convert a virtual path (e.g. `/home/user/file.txt`) to an S3 key.
     * Strips the leading `/` and prepends the configured prefix.
     */
    private toKey(path: string): string {
        const normalized = path.replace(/\/+/g, '/').replace(/^\/+/, '');
        return this.prefix + normalized;
    }

    /**
     * Convert an S3 key back to a virtual path.
     */
    private fromKey(key: string): string {
        const withoutPrefix = key.startsWith(this.prefix)
            ? key.slice(this.prefix.length)
            : key;
        return '/' + withoutPrefix;
    }

    /**
     * Ensure a directory key ends with `/`.
     */
    private toDirKey(path: string): string {
        const key = this.toKey(path);
        return key.endsWith('/') ? key : key + '/';
    }

    async list(path: string): Promise<FileEntry[]> {
        const prefix = path === '/' || path === '' ? this.prefix : this.toDirKey(path);

        const response = await this.client.send(
            new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix,
                Delimiter: '/',
            }),
        );

        const entries: FileEntry[] = [];

        // Directories from CommonPrefixes
        if (response.CommonPrefixes) {
            for (const cp of response.CommonPrefixes) {
                if (!cp.Prefix) continue;
                const fullPath = this.fromKey(cp.Prefix);
                const name = fullPath.replace(/\/+$/, '').split('/').pop() ?? '';
                if (name) {
                    entries.push({
                        name,
                        type: 'directory',
                        size: 0,
                        modified: '',
                    });
                }
            }
        }

        // Files from Contents
        if (response.Contents) {
            for (const obj of response.Contents) {
                if (!obj.Key) continue;
                // Skip the directory marker itself
                if (obj.Key === prefix) continue;
                const fullPath = this.fromKey(obj.Key);
                const name = fullPath.split('/').pop() ?? '';
                if (name) {
                    entries.push({
                        name,
                        type: 'file',
                        size: obj.Size ?? 0,
                        modified: obj.LastModified?.toISOString() ?? '',
                    });
                }
            }
        }

        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    async readFile(path: string): Promise<string> {
        const key = this.toKey(path);

        try {
            const response = await this.client.send(
                new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                }),
            );

            if (!response.Body) {
                return '';
            }

            return await response.Body.transformToString('utf-8');
        } catch (err: any) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                throw new FileNotFoundError(path);
            }
            throw err;
        }
    }

    async writeFile(path: string, content: string | Buffer): Promise<void> {
        const key = this.toKey(path);
        const body = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: body,
            }),
        );
    }

    async stat(path: string): Promise<FileStat> {
        const key = this.toKey(path);

        // Try as file first
        try {
            const response = await this.client.send(
                new HeadObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                }),
            );

            const name = path.replace(/\/+$/, '').split('/').pop() ?? '';
            return {
                name,
                type: 'file',
                size: response.ContentLength ?? 0,
                created: response.LastModified?.toISOString() ?? '',
                modified: response.LastModified?.toISOString() ?? '',
            };
        } catch (err: any) {
            if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
                throw err;
            }
        }

        // Try as directory (check for marker or any contents under prefix)
        const dirKey = this.toDirKey(path);

        // Check for directory marker
        try {
            await this.client.send(
                new HeadObjectCommand({
                    Bucket: this.bucket,
                    Key: dirKey,
                }),
            );

            const name = path.replace(/\/+$/, '').split('/').pop() ?? '';
            return {
                name,
                type: 'directory',
                size: 0,
                created: '',
                modified: '',
            };
        } catch {
            // No marker, check if anything exists under this prefix
        }

        const listResponse = await this.client.send(
            new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: dirKey,
                MaxKeys: 1,
            }),
        );

        if (listResponse.Contents && listResponse.Contents.length > 0) {
            const name = path.replace(/\/+$/, '').split('/').pop() ?? '';
            return {
                name,
                type: 'directory',
                size: 0,
                created: '',
                modified: '',
            };
        }

        throw new FileNotFoundError(path);
    }

    async mkdir(path: string): Promise<void> {
        const dirKey = this.toDirKey(path);

        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: dirKey,
                Body: Buffer.alloc(0),
            }),
        );
    }

    async remove(path: string, recursive: boolean = false): Promise<void> {
        if (recursive) {
            const prefix = this.toDirKey(path);
            await this.deleteByPrefix(prefix);

            // Also try to delete the path as a file key
            try {
                await this.client.send(
                    new DeleteObjectCommand({
                        Bucket: this.bucket,
                        Key: this.toKey(path),
                    }),
                );
            } catch {
                // Ignore errors for the file key
            }
        } else {
            const key = this.toKey(path);

            // Check if it's a directory
            const dirKey = this.toDirKey(path);
            const listResponse = await this.client.send(
                new ListObjectsV2Command({
                    Bucket: this.bucket,
                    Prefix: dirKey,
                    MaxKeys: 2,
                }),
            );

            const hasContents = listResponse.Contents && listResponse.Contents.length > 0;
            const isOnlyMarker =
                hasContents &&
                listResponse.Contents!.length === 1 &&
                listResponse.Contents![0].Key === dirKey;

            if (hasContents && !isOnlyMarker) {
                throw new IsADirectoryError(path);
            }

            // Delete the directory marker if it exists
            if (isOnlyMarker) {
                await this.client.send(
                    new DeleteObjectCommand({
                        Bucket: this.bucket,
                        Key: dirKey,
                    }),
                );
            } else {
                // Delete as a file
                await this.client.send(
                    new DeleteObjectCommand({
                        Bucket: this.bucket,
                        Key: key,
                    }),
                );
            }
        }
    }

    async copy(src: string, dest: string): Promise<void> {
        const srcKey = this.toKey(src);
        const destKey = this.toKey(dest);

        // Check if source is a file
        try {
            await this.client.send(
                new HeadObjectCommand({
                    Bucket: this.bucket,
                    Key: srcKey,
                }),
            );

            // It's a file, do a single copy
            await this.client.send(
                new CopyObjectCommand({
                    Bucket: this.bucket,
                    CopySource: `${this.bucket}/${srcKey}`,
                    Key: destKey,
                }),
            );
            return;
        } catch (err: any) {
            if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
                throw err;
            }
        }

        // Source might be a directory — copy all objects under the prefix
        const srcPrefix = this.toDirKey(src);
        const destPrefix = this.toDirKey(dest);

        let continuationToken: string | undefined;
        let copied = false;

        do {
            const listResponse = await this.client.send(
                new ListObjectsV2Command({
                    Bucket: this.bucket,
                    Prefix: srcPrefix,
                    ContinuationToken: continuationToken,
                }),
            );

            if (listResponse.Contents) {
                for (const obj of listResponse.Contents) {
                    if (!obj.Key) continue;
                    const relativePart = obj.Key.slice(srcPrefix.length);
                    const newKey = destPrefix + relativePart;

                    await this.client.send(
                        new CopyObjectCommand({
                            Bucket: this.bucket,
                            CopySource: `${this.bucket}/${obj.Key}`,
                            Key: newKey,
                        }),
                    );
                    copied = true;
                }
            }

            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        if (!copied) {
            throw new FileNotFoundError(src);
        }
    }

    async move(src: string, dest: string): Promise<void> {
        await this.copy(src, dest);
        await this.remove(src, true);
    }

    async exists(path: string): Promise<boolean> {
        const key = this.toKey(path);

        // Check as file
        try {
            await this.client.send(
                new HeadObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                }),
            );
            return true;
        } catch {
            // Not a file
        }

        // Check as directory
        const dirKey = this.toDirKey(path);
        const listResponse = await this.client.send(
            new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: dirKey,
                MaxKeys: 1,
            }),
        );

        return (listResponse.Contents?.length ?? 0) > 0;
    }

    async getDownloadStream(path: string): Promise<Readable> {
        const key = this.toKey(path);

        try {
            const response = await this.client.send(
                new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                }),
            );

            if (!response.Body) {
                return Readable.from(Buffer.alloc(0));
            }

            return response.Body as Readable;
        } catch (err: any) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                throw new FileNotFoundError(path);
            }
            throw err;
        }
    }

    async uploadFile(path: string, content: Buffer): Promise<void> {
        await this.writeFile(path, content);
    }

    /**
     * Delete all objects matching a given prefix (used for recursive deletes).
     */
    private async deleteByPrefix(prefix: string): Promise<void> {
        let continuationToken: string | undefined;

        do {
            const listResponse = await this.client.send(
                new ListObjectsV2Command({
                    Bucket: this.bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                }),
            );

            if (listResponse.Contents && listResponse.Contents.length > 0) {
                const objects = listResponse.Contents.filter((o) => o.Key).map((o) => ({
                    Key: o.Key!,
                }));

                await this.client.send(
                    new DeleteObjectsCommand({
                        Bucket: this.bucket,
                        Delete: { Objects: objects },
                    }),
                );
            }

            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);
    }
}
