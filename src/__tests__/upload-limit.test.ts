/**
 * `POST /api/qcli/fs/upload` buffers the file in memory: it is bounded by
 * `maxUploadBytes` (default 100 MiB), and oversize uploads are a JSON 413.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { createFilesystemRouter } from '../controllers/filesystem-controller';
import { createCliServer } from '../create-cli-server';
import { DEFAULT_MAX_UPLOAD_BYTES } from '../filesystem';

function appWith(provider: InMemoryFileStorageProvider, maxUploadBytes?: number) {
    const app = express();
    app.use(express.json());
    app.use('/fs', createFilesystemRouter(provider, maxUploadBytes === undefined ? undefined : { maxUploadBytes }));
    return app;
}

describe('filesystem upload limit', () => {
    it('defaults to 100 MiB', () => {
        expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(104857600);
    });

    it('accepts a file up to the limit', async () => {
        const provider = new InMemoryFileStorageProvider();
        const res = await request(appWith(provider, 1024))
            .post('/fs/upload')
            .field('path', '/ok.bin')
            .attach('file', Buffer.alloc(1024, 1), 'ok.bin');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ path: '/ok.bin', size: 1024 });
    });

    it('refuses a larger file with a JSON 413 and writes nothing', async () => {
        const provider = new InMemoryFileStorageProvider();
        const res = await request(appWith(provider, 1024))
            .post('/fs/upload')
            .field('path', '/big.bin')
            .attach('file', Buffer.alloc(1025, 1), 'big.bin');
        expect(res.status).toBe(413);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toEqual({ error: 'File too large: the upload limit is 1024 bytes' });
        expect(await provider.exists('/big.bin')).toBe(false);
    });

    it('accepts one file per request (400 JSON otherwise, not 500)', async () => {
        const provider = new InMemoryFileStorageProvider();
        const two = await request(appWith(provider))
            .post('/fs/upload')
            .field('path', '/x.txt')
            .attach('file', Buffer.from('a'), 'a.txt')
            .attach('file', Buffer.from('b'), 'b.txt');
        expect(two.status).toBe(400);
        expect(two.body.error).toMatch(/one file/i);

        const unexpected = await request(appWith(provider))
            .post('/fs/upload')
            .field('path', '/x.txt')
            .attach('other', Buffer.from('a'), 'a.txt');
        expect(unexpected.status).toBe(400);
        expect(unexpected.body.error).toMatch(/invalid upload/i);
    });

    it('rejects an invalid limit', () => {
        expect(() => createFilesystemRouter(new InMemoryFileStorageProvider(), { maxUploadBytes: 0 })).toThrow(/maxUploadBytes/);
    });

    it('is configured through setFileStorageProvider(provider, { maxUploadBytes }) on createCliServer', async () => {
        const provider = new InMemoryFileStorageProvider();
        const { app } = createCliServer({
            configure: (b) => b.setFileStorageProvider(provider, { maxUploadBytes: 10 }),
        });
        const res = await request(app)
            .post('/api/qcli/fs/upload')
            .field('path', '/big.txt')
            .attach('file', Buffer.alloc(11, 65), 'big.txt');
        expect(res.status).toBe(413);
        const ok = await request(app)
            .post('/api/qcli/fs/upload')
            .field('path', '/ok.txt')
            .attach('file', Buffer.alloc(10, 65), 'ok.txt');
        expect(ok.status).toBe(200);
    });
});
