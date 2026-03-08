import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryFileStorageProvider } from '../../plugins/filesystem';
import {
    FileNotFoundError,
    IsADirectoryError,
    NotADirectoryError,
    FileExistsError,
} from '../../plugins/filesystem';

describe('InMemoryFileStorageProvider', () => {
    let provider: InMemoryFileStorageProvider;

    beforeEach(() => {
        provider = new InMemoryFileStorageProvider();
    });

    describe('mkdir', () => {
        it('should create a directory', async () => {
            await provider.mkdir('/mydir');
            const entries = await provider.list('/');
            expect(entries).toHaveLength(1);
            expect(entries[0].name).toBe('mydir');
            expect(entries[0].type).toBe('directory');
        });

        it('should create directories recursively', async () => {
            await provider.mkdir('/a/b/c', true);
            const rootEntries = await provider.list('/');
            expect(rootEntries).toHaveLength(1);
            expect(rootEntries[0].name).toBe('a');

            const aEntries = await provider.list('/a');
            expect(aEntries).toHaveLength(1);
            expect(aEntries[0].name).toBe('b');

            const bEntries = await provider.list('/a/b');
            expect(bEntries).toHaveLength(1);
            expect(bEntries[0].name).toBe('c');
        });

        it('should not fail when recursive and intermediate dirs already exist', async () => {
            await provider.mkdir('/a', false);
            await provider.mkdir('/a/b/c', true);
            const entries = await provider.list('/a/b');
            expect(entries).toHaveLength(1);
            expect(entries[0].name).toBe('c');
        });

        it('should throw FileExistsError for existing path (non-recursive)', async () => {
            await provider.mkdir('/mydir');
            await expect(provider.mkdir('/mydir')).rejects.toThrow(FileExistsError);
        });

        it('should throw FileNotFoundError when parent missing (non-recursive)', async () => {
            await expect(provider.mkdir('/missing/child')).rejects.toThrow(FileNotFoundError);
        });
    });

    describe('writeFile / readFile', () => {
        it('should write and read a file', async () => {
            await provider.writeFile('/hello.txt', 'Hello, world!');
            const content = await provider.readFile('/hello.txt');
            expect(content).toBe('Hello, world!');
        });

        it('should overwrite existing file', async () => {
            await provider.writeFile('/file.txt', 'first');
            await provider.writeFile('/file.txt', 'second');
            const content = await provider.readFile('/file.txt');
            expect(content).toBe('second');
        });

        it('should write a Buffer', async () => {
            const buf = Buffer.from('binary data', 'utf-8');
            await provider.writeFile('/buf.txt', buf);
            const content = await provider.readFile('/buf.txt');
            expect(content).toBe('binary data');
        });

        it('should throw FileNotFoundError when parent directory is missing', async () => {
            await expect(provider.writeFile('/no/such/dir/file.txt', 'data'))
                .rejects.toThrow(FileNotFoundError);
        });

        it('should throw IsADirectoryError when writing to a directory path', async () => {
            await provider.mkdir('/mydir');
            await expect(provider.writeFile('/mydir', 'data'))
                .rejects.toThrow(IsADirectoryError);
        });

        it('should throw FileNotFoundError when reading nonexistent file', async () => {
            await expect(provider.readFile('/nope.txt'))
                .rejects.toThrow(FileNotFoundError);
        });

        it('should throw IsADirectoryError when reading a directory', async () => {
            await provider.mkdir('/mydir');
            await expect(provider.readFile('/mydir'))
                .rejects.toThrow(IsADirectoryError);
        });
    });

    describe('list', () => {
        it('should list directory contents sorted by name', async () => {
            await provider.writeFile('/z.txt', 'z');
            await provider.writeFile('/a.txt', 'a');
            await provider.mkdir('/m_dir');

            const entries = await provider.list('/');
            expect(entries).toHaveLength(3);
            expect(entries[0].name).toBe('a.txt');
            expect(entries[0].type).toBe('file');
            expect(entries[1].name).toBe('m_dir');
            expect(entries[1].type).toBe('directory');
            expect(entries[2].name).toBe('z.txt');
            expect(entries[2].type).toBe('file');
        });

        it('should return empty array for empty directory', async () => {
            await provider.mkdir('/empty');
            const entries = await provider.list('/empty');
            expect(entries).toEqual([]);
        });

        it('should throw FileNotFoundError for missing directory', async () => {
            await expect(provider.list('/nonexistent'))
                .rejects.toThrow(FileNotFoundError);
        });

        it('should throw NotADirectoryError for a file', async () => {
            await provider.writeFile('/file.txt', 'data');
            await expect(provider.list('/file.txt'))
                .rejects.toThrow(NotADirectoryError);
        });
    });

    describe('stat', () => {
        it('should return file stats', async () => {
            await provider.writeFile('/readme.txt', 'Hello!');
            const st = await provider.stat('/readme.txt');
            expect(st.name).toBe('readme.txt');
            expect(st.type).toBe('file');
            expect(st.size).toBe(Buffer.byteLength('Hello!', 'utf-8'));
            expect(st.permissions).toBe('644');
            expect(st.created).toBeDefined();
            expect(st.modified).toBeDefined();
        });

        it('should return directory stats', async () => {
            await provider.mkdir('/docs');
            const st = await provider.stat('/docs');
            expect(st.name).toBe('docs');
            expect(st.type).toBe('directory');
            expect(st.size).toBe(0);
            expect(st.permissions).toBe('755');
        });

        it('should return root stats', async () => {
            const st = await provider.stat('/');
            expect(st.type).toBe('directory');
        });

        it('should throw FileNotFoundError for missing path', async () => {
            await expect(provider.stat('/missing'))
                .rejects.toThrow(FileNotFoundError);
        });
    });

    describe('remove', () => {
        it('should remove a file', async () => {
            await provider.writeFile('/del.txt', 'gone');
            await provider.remove('/del.txt');
            const exists = await provider.exists('/del.txt');
            expect(exists).toBe(false);
        });

        it('should throw IsADirectoryError when removing dir without recursive', async () => {
            await provider.mkdir('/mydir');
            await expect(provider.remove('/mydir'))
                .rejects.toThrow(IsADirectoryError);
        });

        it('should remove directory recursively', async () => {
            await provider.mkdir('/a/b', true);
            await provider.writeFile('/a/b/file.txt', 'deep');
            await provider.remove('/a', true);
            const exists = await provider.exists('/a');
            expect(exists).toBe(false);
        });

        it('should throw FileNotFoundError for missing path', async () => {
            await expect(provider.remove('/nofile'))
                .rejects.toThrow(FileNotFoundError);
        });
    });

    describe('copy', () => {
        it('should copy a file', async () => {
            await provider.writeFile('/src.txt', 'content');
            await provider.copy('/src.txt', '/dest.txt');

            const srcContent = await provider.readFile('/src.txt');
            const destContent = await provider.readFile('/dest.txt');
            expect(srcContent).toBe('content');
            expect(destContent).toBe('content');
        });

        it('should deep copy a directory', async () => {
            await provider.mkdir('/src');
            await provider.writeFile('/src/a.txt', 'aaa');
            await provider.mkdir('/src/sub');
            await provider.writeFile('/src/sub/b.txt', 'bbb');

            await provider.copy('/src', '/dest');

            const destEntries = await provider.list('/dest');
            expect(destEntries).toHaveLength(2);
            expect(destEntries.map(e => e.name)).toEqual(['a.txt', 'sub']);

            const nested = await provider.readFile('/dest/sub/b.txt');
            expect(nested).toBe('bbb');
        });

        it('should produce an independent copy (modifying copy does not affect original)', async () => {
            await provider.writeFile('/orig.txt', 'original');
            await provider.copy('/orig.txt', '/clone.txt');
            await provider.writeFile('/clone.txt', 'modified');

            const orig = await provider.readFile('/orig.txt');
            expect(orig).toBe('original');
        });

        it('should throw FileNotFoundError when source missing', async () => {
            await expect(provider.copy('/noexist', '/dest'))
                .rejects.toThrow(FileNotFoundError);
        });

        it('should throw FileNotFoundError when dest parent missing', async () => {
            await provider.writeFile('/src.txt', 'data');
            await expect(provider.copy('/src.txt', '/no/parent/dest.txt'))
                .rejects.toThrow(FileNotFoundError);
        });
    });

    describe('move', () => {
        it('should move/rename a file', async () => {
            await provider.writeFile('/old.txt', 'data');
            await provider.move('/old.txt', '/new.txt');

            const exists = await provider.exists('/old.txt');
            expect(exists).toBe(false);

            const content = await provider.readFile('/new.txt');
            expect(content).toBe('data');
        });

        it('should move a directory', async () => {
            await provider.mkdir('/srcdir');
            await provider.writeFile('/srcdir/f.txt', 'inside');
            await provider.move('/srcdir', '/destdir');

            const exists = await provider.exists('/srcdir');
            expect(exists).toBe(false);

            const content = await provider.readFile('/destdir/f.txt');
            expect(content).toBe('inside');
        });
    });

    describe('exists', () => {
        it('should return true for existing file', async () => {
            await provider.writeFile('/file.txt', 'hi');
            expect(await provider.exists('/file.txt')).toBe(true);
        });

        it('should return true for existing directory', async () => {
            await provider.mkdir('/dir');
            expect(await provider.exists('/dir')).toBe(true);
        });

        it('should return true for root', async () => {
            expect(await provider.exists('/')).toBe(true);
        });

        it('should return false for missing path', async () => {
            expect(await provider.exists('/nope')).toBe(false);
        });
    });

    describe('getDownloadStream', () => {
        it('should return a readable stream with file content', async () => {
            await provider.writeFile('/dl.txt', 'stream content');
            const stream = await provider.getDownloadStream('/dl.txt');

            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const result = Buffer.concat(chunks).toString('utf-8');
            expect(result).toBe('stream content');
        });

        it('should throw FileNotFoundError for missing file', async () => {
            await expect(provider.getDownloadStream('/nope.txt'))
                .rejects.toThrow(FileNotFoundError);
        });

        it('should throw IsADirectoryError for a directory', async () => {
            await provider.mkdir('/dir');
            await expect(provider.getDownloadStream('/dir'))
                .rejects.toThrow(IsADirectoryError);
        });
    });

    describe('uploadFile', () => {
        it('should upload and read back a file', async () => {
            const buf = Buffer.from('uploaded data');
            await provider.uploadFile('/upload.txt', buf);
            const content = await provider.readFile('/upload.txt');
            expect(content).toBe('uploaded data');
        });
    });
});
