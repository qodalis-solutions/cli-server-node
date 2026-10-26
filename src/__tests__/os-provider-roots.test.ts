/**
 * The OS provider never removes or moves an allowed root itself
 * (`DELETE /api/qcli/fs/rm?path=<root>` used to wipe the whole share).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { OsFileStorageProvider, PermissionDeniedError } from '@qodalis/cli-server-plugin-filesystem';
import { createFilesystemRouter } from '../controllers/filesystem-controller';

describe('OsFileStorageProvider: allowed roots', () => {
    let base: string;
    let root: string;
    let other: string;
    let provider: OsFileStorageProvider;

    beforeEach(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qcli-roots-')));
        root = path.join(base, 'share');
        other = path.join(base, 'other');
        fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(root, 'a.txt'), 'a');
        fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'b');
        fs.mkdirSync(other);
        provider = new OsFileStorageProvider({ allowedPaths: [root, other] });
    });

    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('refuses to remove an allowed root (also through a trailing slash or a symlink)', async () => {
        await expect(provider.remove(root, true)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(provider.remove(root + '/', true)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(provider.remove(path.join(root, 'sub', '..'), true)).rejects.toBeInstanceOf(PermissionDeniedError);
        const link = path.join(other, 'link-to-share');
        fs.symlinkSync(root, link);
        await expect(provider.remove(link, true)).rejects.toBeInstanceOf(PermissionDeniedError);
        expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'sub', 'b.txt'))).toBe(true);
    });

    it('refuses to move an allowed root, or onto an allowed root', async () => {
        await expect(provider.move(root, path.join(other, 'moved'))).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(provider.move(path.join(root, 'sub'), other)).rejects.toBeInstanceOf(PermissionDeniedError);
        expect(fs.existsSync(path.join(root, 'sub', 'b.txt'))).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
    });

    it('still lists, writes, removes and moves entries inside a root', async () => {
        expect((await provider.list(root)).map((e) => e.name)).toEqual(['a.txt', 'sub']);
        await provider.writeFile(path.join(root, 'c.txt'), 'c');
        await provider.move(path.join(root, 'c.txt'), path.join(other, 'c.txt'));
        expect(fs.readFileSync(path.join(other, 'c.txt'), 'utf-8')).toBe('c');
        await provider.remove(path.join(root, 'sub'), true);
        expect(fs.existsSync(path.join(root, 'sub'))).toBe(false);
        await provider.remove(path.join(root, 'a.txt'));
        expect(fs.readdirSync(root)).toEqual([]);
    });

    it('DELETE /fs/rm of a root answers 403 and keeps the share', async () => {
        const app = express();
        app.use(express.json());
        app.use('/fs', createFilesystemRouter(provider));
        const res = await request(app).delete('/fs/rm').query({ path: root });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/access denied/i);
        expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(true);

        const inside = await request(app).delete('/fs/rm').query({ path: path.join(root, 'a.txt') });
        expect(inside.status).toBe(200);
    });
});
