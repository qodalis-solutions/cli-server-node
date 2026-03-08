import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFilesystemRouter } from '../controllers/filesystem-controller';
import { InMemoryFileStorageProvider } from '../../plugins/filesystem';

describe('Filesystem Controller', () => {
    let app: express.Express;
    let provider: InMemoryFileStorageProvider;

    beforeEach(() => {
        provider = new InMemoryFileStorageProvider();
        app = express();
        app.use(express.json());
        app.use('/fs', createFilesystemRouter(provider));
    });

    // ---------------------------------------------------------------- mkdir
    describe('POST /fs/mkdir', () => {
        it('should create a directory and return the path', async () => {
            const res = await request(app)
                .post('/fs/mkdir')
                .send({ path: '/testdir' })
                .expect(200);

            expect(res.body).toEqual({ path: '/testdir' });

            // Verify through the provider
            const exists = await provider.exists('/testdir');
            expect(exists).toBe(true);
        });

        it('should create nested directories (mkdir uses recursive)', async () => {
            const res = await request(app)
                .post('/fs/mkdir')
                .send({ path: '/a/b/c' })
                .expect(200);

            expect(res.body).toEqual({ path: '/a/b/c' });
            expect(await provider.exists('/a/b/c')).toBe(true);
        });

        it('should return 400 when path is missing', async () => {
            const res = await request(app)
                .post('/fs/mkdir')
                .send({})
                .expect(400);

            expect(res.body.error).toMatch(/missing/i);
        });
    });

    // ------------------------------------------------------------------ ls
    describe('GET /fs/ls', () => {
        it('should list directory contents', async () => {
            await provider.mkdir('/dir');
            await provider.writeFile('/dir/a.txt', 'aaa');
            await provider.writeFile('/dir/b.txt', 'bbb');

            const res = await request(app)
                .get('/fs/ls')
                .query({ path: '/dir' })
                .expect(200);

            expect(res.body.entries).toHaveLength(2);
            expect(res.body.entries[0].name).toBe('a.txt');
            expect(res.body.entries[1].name).toBe('b.txt');
        });

        it('should return empty entries for empty directory', async () => {
            await provider.mkdir('/empty');

            const res = await request(app)
                .get('/fs/ls')
                .query({ path: '/empty' })
                .expect(200);

            expect(res.body.entries).toEqual([]);
        });

        it('should return 400 when path is missing', async () => {
            const res = await request(app)
                .get('/fs/ls')
                .expect(400);

            expect(res.body.error).toMatch(/missing/i);
        });

        it('should return 404 for nonexistent directory', async () => {
            const res = await request(app)
                .get('/fs/ls')
                .query({ path: '/nonexistent' })
                .expect(404);

            expect(res.body.error).toBeDefined();
        });

        it('should return 400 for file path (not a directory)', async () => {
            await provider.writeFile('/file.txt', 'data');

            const res = await request(app)
                .get('/fs/ls')
                .query({ path: '/file.txt' })
                .expect(400);

            expect(res.body.error).toMatch(/not a directory/i);
        });
    });

    // ----------------------------------------------------------------- cat
    describe('GET /fs/cat', () => {
        it('should read file content', async () => {
            await provider.writeFile('/readme.txt', 'Hello, world!');

            const res = await request(app)
                .get('/fs/cat')
                .query({ path: '/readme.txt' })
                .expect(200);

            expect(res.body.content).toBe('Hello, world!');
        });

        it('should return 400 when path is missing', async () => {
            const res = await request(app)
                .get('/fs/cat')
                .expect(400);

            expect(res.body.error).toMatch(/missing/i);
        });

        it('should return 404 for nonexistent file', async () => {
            const res = await request(app)
                .get('/fs/cat')
                .query({ path: '/nope.txt' })
                .expect(404);

            expect(res.body.error).toBeDefined();
        });

        it('should return 400 when reading a directory', async () => {
            await provider.mkdir('/mydir');

            const res = await request(app)
                .get('/fs/cat')
                .query({ path: '/mydir' })
                .expect(400);

            expect(res.body.error).toMatch(/directory/i);
        });
    });

    // ---------------------------------------------------------------- stat
    describe('GET /fs/stat', () => {
        it('should return file stats', async () => {
            await provider.writeFile('/info.txt', 'some data');

            const res = await request(app)
                .get('/fs/stat')
                .query({ path: '/info.txt' })
                .expect(200);

            expect(res.body.name).toBe('info.txt');
            expect(res.body.type).toBe('file');
            expect(res.body.size).toBe(Buffer.byteLength('some data', 'utf-8'));
            expect(res.body.permissions).toBe('644');
        });

        it('should return directory stats', async () => {
            await provider.mkdir('/docs');

            const res = await request(app)
                .get('/fs/stat')
                .query({ path: '/docs' })
                .expect(200);

            expect(res.body.name).toBe('docs');
            expect(res.body.type).toBe('directory');
        });

        it('should return 400 when path is missing', async () => {
            await request(app).get('/fs/stat').expect(400);
        });

        it('should return 404 for nonexistent path', async () => {
            await request(app)
                .get('/fs/stat')
                .query({ path: '/nothing' })
                .expect(404);
        });
    });

    // ------------------------------------------------------------ download
    describe('GET /fs/download', () => {
        it('should download file with Content-Disposition header', async () => {
            await provider.writeFile('/dl.txt', 'download me');

            const res = await request(app)
                .get('/fs/download')
                .query({ path: '/dl.txt' })
                .expect(200);

            expect(res.headers['content-disposition']).toContain('dl.txt');
            expect(res.text).toBe('download me');
        });

        it('should return 400 when path is missing', async () => {
            await request(app).get('/fs/download').expect(400);
        });

        it('should return 404 for nonexistent file', async () => {
            await request(app)
                .get('/fs/download')
                .query({ path: '/nope.txt' })
                .expect(404);
        });
    });

    // ------------------------------------------------------------------ rm
    describe('DELETE /fs/rm', () => {
        it('should delete a file', async () => {
            await provider.writeFile('/del.txt', 'bye');

            const res = await request(app)
                .delete('/fs/rm')
                .query({ path: '/del.txt' })
                .expect(200);

            expect(res.body.deleted).toBe('/del.txt');
            expect(await provider.exists('/del.txt')).toBe(false);
        });

        it('should delete a directory recursively', async () => {
            await provider.mkdir('/rmdir/sub', true);
            await provider.writeFile('/rmdir/sub/file.txt', 'data');

            const res = await request(app)
                .delete('/fs/rm')
                .query({ path: '/rmdir' })
                .expect(200);

            expect(res.body.deleted).toBe('/rmdir');
            expect(await provider.exists('/rmdir')).toBe(false);
        });

        it('should return 400 when path is missing', async () => {
            await request(app).delete('/fs/rm').expect(400);
        });

        it('should return 404 for nonexistent path', async () => {
            await request(app)
                .delete('/fs/rm')
                .query({ path: '/ghost' })
                .expect(404);
        });
    });

    // -------------------------------------------------------------- upload
    describe('POST /fs/upload', () => {
        it('should upload a file via multipart', async () => {
            const res = await request(app)
                .post('/fs/upload')
                .field('path', '/uploaded.txt')
                .attach('file', Buffer.from('file content'), 'uploaded.txt')
                .expect(200);

            expect(res.body.path).toBe('/uploaded.txt');
            expect(res.body.size).toBe(Buffer.byteLength('file content'));

            const content = await provider.readFile('/uploaded.txt');
            expect(content).toBe('file content');
        });

        it('should return 400 when path is missing', async () => {
            const res = await request(app)
                .post('/fs/upload')
                .attach('file', Buffer.from('data'), 'test.txt')
                .expect(400);

            expect(res.body.error).toMatch(/missing/i);
        });

        it('should return 400 when file is missing', async () => {
            const res = await request(app)
                .post('/fs/upload')
                .field('path', '/target.txt')
                .expect(400);

            expect(res.body.error).toMatch(/missing/i);
        });
    });
});
