import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'stream';

// Mock @aws-sdk/client-s3 before importing the provider
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
    const S3Client = vi.fn(function (this: any) {
        this.send = mockSend;
    });
    return {
        S3Client,
        ListObjectsV2Command: vi.fn(function (this: any, input: any) {
            Object.assign(this, { _type: 'ListObjectsV2', ...input });
        }),
        GetObjectCommand: vi.fn(function (this: any, input: any) {
            Object.assign(this, { _type: 'GetObject', ...input });
        }),
        PutObjectCommand: vi.fn(function (this: any, input: any) {
            Object.assign(this, { _type: 'PutObject', ...input });
        }),
        DeleteObjectCommand: vi.fn(function (this: any, input: any) {
            Object.assign(this, { _type: 'DeleteObject', ...input });
        }),
        DeleteObjectsCommand: vi.fn(function (this: any, input: any) {
            Object.assign(this, { _type: 'DeleteObjects', ...input });
        }),
        HeadObjectCommand: vi.fn(function (this: any, input: any) {
            Object.assign(this, { _type: 'HeadObject', ...input });
        }),
        CopyObjectCommand: vi.fn(function (this: any, input: any) {
            Object.assign(this, { _type: 'CopyObject', ...input });
        }),
    };
});

import { S3FileStorageProvider } from '@qodalis/cli-server-plugin-filesystem-s3';
import { FileNotFoundError } from '@qodalis/cli-server-plugin-filesystem';

describe('S3FileStorageProvider', () => {
    let provider: S3FileStorageProvider;

    beforeEach(() => {
        mockSend.mockReset();
        provider = new S3FileStorageProvider({
            bucket: 'test-bucket',
            region: 'us-east-1',
        });
    });

    describe('path-to-key mapping', () => {
        it('should map paths without prefix', () => {
            // We test the mapping indirectly through writeFile
            mockSend.mockResolvedValueOnce({});

            return provider.writeFile('/home/user/file.txt', 'hello').then(() => {
                const sentCommand = mockSend.mock.calls[0][0];
                expect(sentCommand.Key).toBe('home/user/file.txt');
                expect(sentCommand.Bucket).toBe('test-bucket');
            });
        });

        it('should map paths with prefix', async () => {
            const prefixedProvider = new S3FileStorageProvider({
                bucket: 'test-bucket',
                prefix: 'cli-files/',
            });

            mockSend.mockResolvedValueOnce({});

            await prefixedProvider.writeFile('/home/user/file.txt', 'hello');

            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.Key).toBe('cli-files/home/user/file.txt');
        });

        it('should strip double slashes from paths', async () => {
            mockSend.mockResolvedValueOnce({});

            await provider.writeFile('//home//user//file.txt', 'hello');

            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.Key).toBe('home/user/file.txt');
        });
    });

    describe('list', () => {
        it('should combine directories and files from S3 response', async () => {
            mockSend.mockResolvedValueOnce({
                CommonPrefixes: [{ Prefix: 'docs/' }, { Prefix: 'images/' }],
                Contents: [
                    {
                        Key: 'readme.txt',
                        Size: 100,
                        LastModified: new Date('2025-01-01T00:00:00Z'),
                    },
                ],
            });

            const entries = await provider.list('/');

            expect(entries).toHaveLength(3);
            expect(entries[0]).toEqual({
                name: 'docs',
                type: 'directory',
                size: 0,
                modified: '',
            });
            expect(entries[1]).toEqual({
                name: 'images',
                type: 'directory',
                size: 0,
                modified: '',
            });
            expect(entries[2]).toEqual({
                name: 'readme.txt',
                type: 'file',
                size: 100,
                modified: '2025-01-01T00:00:00.000Z',
            });
        });

        it('should skip the directory marker itself in listings', async () => {
            mockSend.mockResolvedValueOnce({
                CommonPrefixes: [],
                Contents: [
                    {
                        Key: 'docs/',
                        Size: 0,
                        LastModified: new Date('2025-01-01T00:00:00Z'),
                    },
                    {
                        Key: 'docs/file.txt',
                        Size: 50,
                        LastModified: new Date('2025-01-01T00:00:00Z'),
                    },
                ],
            });

            const entries = await provider.list('/docs');

            expect(entries).toHaveLength(1);
            expect(entries[0].name).toBe('file.txt');
        });

        it('should list with prefix option', async () => {
            const prefixedProvider = new S3FileStorageProvider({
                bucket: 'test-bucket',
                prefix: 'data',
            });

            mockSend.mockResolvedValueOnce({
                CommonPrefixes: [],
                Contents: [
                    {
                        Key: 'data/file.txt',
                        Size: 10,
                        LastModified: new Date('2025-01-01T00:00:00Z'),
                    },
                ],
            });

            await prefixedProvider.list('/');

            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.Prefix).toBe('data/');
        });
    });

    describe('readFile', () => {
        it('should return file content as string', async () => {
            mockSend.mockResolvedValueOnce({
                Body: {
                    transformToString: vi.fn().mockResolvedValue('file contents here'),
                },
            });

            const result = await provider.readFile('/test.txt');
            expect(result).toBe('file contents here');
        });

        it('should throw FileNotFoundError for missing files', async () => {
            const notFoundError = new Error('NoSuchKey');
            (notFoundError as any).name = 'NoSuchKey';
            mockSend.mockRejectedValueOnce(notFoundError);

            await expect(provider.readFile('/missing.txt')).rejects.toThrow(FileNotFoundError);
        });

        it('should return empty string when Body is null', async () => {
            mockSend.mockResolvedValueOnce({ Body: null });

            const result = await provider.readFile('/empty.txt');
            expect(result).toBe('');
        });
    });

    describe('writeFile', () => {
        it('should write string content', async () => {
            mockSend.mockResolvedValueOnce({});

            await provider.writeFile('/test.txt', 'hello world');

            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.Key).toBe('test.txt');
            expect(Buffer.isBuffer(sentCommand.Body)).toBe(true);
            expect(sentCommand.Body.toString('utf-8')).toBe('hello world');
        });

        it('should write Buffer content', async () => {
            mockSend.mockResolvedValueOnce({});

            const buf = Buffer.from('binary data');
            await provider.writeFile('/data.bin', buf);

            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.Body).toBe(buf);
        });
    });

    describe('stat', () => {
        it('should return file stat for existing file', async () => {
            mockSend.mockResolvedValueOnce({
                ContentLength: 256,
                LastModified: new Date('2025-06-15T12:00:00Z'),
            });

            const result = await provider.stat('/file.txt');

            expect(result).toEqual({
                name: 'file.txt',
                type: 'file',
                size: 256,
                created: '2025-06-15T12:00:00.000Z',
                modified: '2025-06-15T12:00:00.000Z',
            });
        });

        it('should return directory stat when dir marker exists', async () => {
            // First HeadObject for file key -> 404
            const notFound = new Error('NotFound');
            (notFound as any).name = 'NotFound';
            mockSend.mockRejectedValueOnce(notFound);

            // Second HeadObject for dir marker -> found
            mockSend.mockResolvedValueOnce({});

            const result = await provider.stat('/mydir');

            expect(result.type).toBe('directory');
            expect(result.name).toBe('mydir');
        });

        it('should return directory stat when objects exist under prefix', async () => {
            // HeadObject for file key -> 404
            const notFound = new Error('NotFound');
            (notFound as any).name = 'NotFound';
            mockSend.mockRejectedValueOnce(notFound);

            // HeadObject for dir marker -> 404
            mockSend.mockRejectedValueOnce(notFound);

            // ListObjectsV2 finds objects under prefix
            mockSend.mockResolvedValueOnce({
                Contents: [{ Key: 'mydir/file.txt' }],
            });

            const result = await provider.stat('/mydir');

            expect(result.type).toBe('directory');
        });

        it('should throw FileNotFoundError when nothing exists', async () => {
            const notFound = new Error('NotFound');
            (notFound as any).name = 'NotFound';
            mockSend.mockRejectedValueOnce(notFound);
            mockSend.mockRejectedValueOnce(notFound);
            mockSend.mockResolvedValueOnce({ Contents: [] });

            await expect(provider.stat('/nonexistent')).rejects.toThrow(FileNotFoundError);
        });
    });

    describe('mkdir', () => {
        it('should create a zero-byte marker with trailing slash', async () => {
            mockSend.mockResolvedValueOnce({});

            await provider.mkdir('/newdir');

            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.Key).toBe('newdir/');
            expect(sentCommand.Body).toEqual(Buffer.alloc(0));
        });
    });

    describe('exists', () => {
        it('should return true when file exists', async () => {
            mockSend.mockResolvedValueOnce({}); // HeadObject succeeds

            const result = await provider.exists('/file.txt');
            expect(result).toBe(true);
        });

        it('should return true when directory has contents', async () => {
            // HeadObject for file key -> 404
            const notFound = new Error('NotFound');
            (notFound as any).name = 'NotFound';
            mockSend.mockRejectedValueOnce(notFound);

            // ListObjectsV2 finds objects
            mockSend.mockResolvedValueOnce({
                Contents: [{ Key: 'dir/file.txt' }],
            });

            const result = await provider.exists('/dir');
            expect(result).toBe(true);
        });

        it('should return false when nothing exists', async () => {
            const notFound = new Error('NotFound');
            (notFound as any).name = 'NotFound';
            mockSend.mockRejectedValueOnce(notFound);

            mockSend.mockResolvedValueOnce({ Contents: [] });

            const result = await provider.exists('/nonexistent');
            expect(result).toBe(false);
        });
    });

    describe('remove', () => {
        it('should delete a single file', async () => {
            // ListObjectsV2 to check if directory -> no contents
            mockSend.mockResolvedValueOnce({ Contents: [] });
            // DeleteObjectCommand
            mockSend.mockResolvedValueOnce({});

            await provider.remove('/file.txt');

            const deleteCommand = mockSend.mock.calls[1][0];
            expect(deleteCommand._type).toBe('DeleteObject');
            expect(deleteCommand.Key).toBe('file.txt');
        });

        it('should recursively delete all objects under prefix', async () => {
            // ListObjectsV2 returns objects
            mockSend.mockResolvedValueOnce({
                Contents: [
                    { Key: 'dir/a.txt' },
                    { Key: 'dir/b.txt' },
                    { Key: 'dir/' },
                ],
            });
            // DeleteObjectsCommand
            mockSend.mockResolvedValueOnce({});
            // DeleteObjectCommand for file key (best-effort)
            mockSend.mockResolvedValueOnce({});

            await provider.remove('/dir', true);

            const batchDelete = mockSend.mock.calls[1][0];
            expect(batchDelete._type).toBe('DeleteObjects');
            expect(batchDelete.Delete.Objects).toHaveLength(3);
        });
    });

    describe('copy', () => {
        it('should copy a single file', async () => {
            // HeadObject succeeds (source is a file)
            mockSend.mockResolvedValueOnce({});
            // CopyObject
            mockSend.mockResolvedValueOnce({});

            await provider.copy('/src.txt', '/dest.txt');

            const copyCommand = mockSend.mock.calls[1][0];
            expect(copyCommand._type).toBe('CopyObject');
            expect(copyCommand.CopySource).toBe('test-bucket/src.txt');
            expect(copyCommand.Key).toBe('dest.txt');
        });

        it('should copy all objects for a directory', async () => {
            // HeadObject for file key -> 404
            const notFound = new Error('NotFound');
            (notFound as any).name = 'NotFound';
            mockSend.mockRejectedValueOnce(notFound);

            // ListObjectsV2 returns dir contents
            mockSend.mockResolvedValueOnce({
                Contents: [
                    { Key: 'srcdir/a.txt' },
                    { Key: 'srcdir/b.txt' },
                ],
            });

            // Two CopyObject calls
            mockSend.mockResolvedValueOnce({});
            mockSend.mockResolvedValueOnce({});

            await provider.copy('/srcdir', '/destdir');

            expect(mockSend).toHaveBeenCalledTimes(4);
            const copy1 = mockSend.mock.calls[2][0];
            expect(copy1.CopySource).toBe('test-bucket/srcdir/a.txt');
            expect(copy1.Key).toBe('destdir/a.txt');
        });
    });

    describe('move', () => {
        it('should copy then delete', async () => {
            // HeadObject for copy (source is a file)
            mockSend.mockResolvedValueOnce({});
            // CopyObject
            mockSend.mockResolvedValueOnce({});
            // remove: recursive delete - ListObjectsV2 for prefix
            mockSend.mockResolvedValueOnce({ Contents: [] });
            // remove: DeleteObjectCommand for file key
            mockSend.mockResolvedValueOnce({});

            await provider.move('/a.txt', '/b.txt');

            // Verify copy happened
            const copyCommand = mockSend.mock.calls[1][0];
            expect(copyCommand._type).toBe('CopyObject');

            // Verify delete happened
            const deleteCommand = mockSend.mock.calls[3][0];
            expect(deleteCommand._type).toBe('DeleteObject');
        });
    });

    describe('getDownloadStream', () => {
        it('should return a readable stream', async () => {
            const readable = Readable.from(Buffer.from('stream content'));
            mockSend.mockResolvedValueOnce({ Body: readable });

            const result = await provider.getDownloadStream('/file.txt');
            expect(result).toBe(readable);
        });

        it('should throw FileNotFoundError for missing files', async () => {
            const notFoundError = new Error('NoSuchKey');
            (notFoundError as any).name = 'NoSuchKey';
            mockSend.mockRejectedValueOnce(notFoundError);

            await expect(provider.getDownloadStream('/missing.txt')).rejects.toThrow(
                FileNotFoundError,
            );
        });
    });

    describe('uploadFile', () => {
        it('should delegate to writeFile', async () => {
            mockSend.mockResolvedValueOnce({});

            const buf = Buffer.from('upload data');
            await provider.uploadFile('/upload.txt', buf);

            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.Key).toBe('upload.txt');
            expect(sentCommand.Body).toBe(buf);
        });
    });

    describe('S3Client configuration', () => {
        it('should configure endpoint for S3-compatible services', async () => {
            const { S3Client } = await import('@aws-sdk/client-s3');
            const MockedS3Client = S3Client as unknown as ReturnType<typeof vi.fn>;
            MockedS3Client.mockClear();

            new S3FileStorageProvider({
                bucket: 'test',
                endpoint: 'http://localhost:9000',
                credentials: {
                    accessKeyId: 'minioadmin',
                    secretAccessKey: 'minioadmin',
                },
            });

            expect(MockedS3Client).toHaveBeenCalledWith(
                expect.objectContaining({
                    endpoint: 'http://localhost:9000',
                    credentials: {
                        accessKeyId: 'minioadmin',
                        secretAccessKey: 'minioadmin',
                    },
                }),
            );
        });
    });
});
