import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import { FileSystemPathValidator } from '../filesystem';

/**
 * Creates an Express router that exposes filesystem operations.
 *
 * Every endpoint validates the requested path against the supplied
 * `FileSystemPathValidator` and returns 403 when access is denied.
 */
export function createFilesystemRouter(validator: FileSystemPathValidator): Router {
    const router = Router();

    const upload = multer({ storage: multer.memoryStorage() });

    // ------------------------------------------------------------------ ls
    router.get('/ls', (req, res) => {
        try {
            const dirPath = req.query.path as string | undefined;
            if (!dirPath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            if (!validator.isPathAllowed(dirPath)) {
                res.status(403).json({ error: 'Access denied' });
                return;
            }

            const resolved = path.resolve(dirPath);
            if (!fs.existsSync(resolved)) {
                res.status(404).json({ error: 'Directory not found' });
                return;
            }

            const dirents = fs.readdirSync(resolved, { withFileTypes: true });
            const entries = dirents.map((d) => {
                const fullPath = path.join(resolved, d.name);
                let size = 0;
                let modified: string | null = null;
                let permissions: string | null = null;

                try {
                    const stat = fs.statSync(fullPath);
                    size = stat.size;
                    modified = stat.mtime.toISOString();
                    permissions = (stat.mode & 0o777).toString(8);
                } catch {
                    // Entry may have been removed between readdir and stat
                }

                return {
                    name: d.name,
                    type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other',
                    size,
                    modified,
                    permissions,
                };
            });

            res.json({ entries });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ----------------------------------------------------------------- cat
    router.get('/cat', (req, res) => {
        try {
            const filePath = req.query.path as string | undefined;
            if (!filePath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            if (!validator.isPathAllowed(filePath)) {
                res.status(403).json({ error: 'Access denied' });
                return;
            }

            const resolved = path.resolve(filePath);
            if (!fs.existsSync(resolved)) {
                res.status(404).json({ error: 'File not found' });
                return;
            }

            const content = fs.readFileSync(resolved, 'utf-8');
            res.json({ content });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ---------------------------------------------------------------- stat
    router.get('/stat', (req, res) => {
        try {
            const filePath = req.query.path as string | undefined;
            if (!filePath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            if (!validator.isPathAllowed(filePath)) {
                res.status(403).json({ error: 'Access denied' });
                return;
            }

            const resolved = path.resolve(filePath);
            if (!fs.existsSync(resolved)) {
                res.status(404).json({ error: 'File not found' });
                return;
            }

            const stat = fs.statSync(resolved);
            res.json({
                name: path.basename(resolved),
                type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
                size: stat.size,
                modified: stat.mtime.toISOString(),
                created: stat.birthtime.toISOString(),
                permissions: (stat.mode & 0o777).toString(8),
            });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ------------------------------------------------------------ download
    router.get('/download', (req, res) => {
        try {
            const filePath = req.query.path as string | undefined;
            if (!filePath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            if (!validator.isPathAllowed(filePath)) {
                res.status(403).json({ error: 'Access denied' });
                return;
            }

            const resolved = path.resolve(filePath);
            if (!fs.existsSync(resolved)) {
                res.status(404).json({ error: 'File not found' });
                return;
            }

            const filename = path.basename(resolved);
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            const stream = fs.createReadStream(resolved);
            stream.pipe(res);
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // -------------------------------------------------------------- upload
    router.post('/upload', upload.single('file'), (req, res) => {
        try {
            const targetPath = req.body?.path as string | undefined;
            if (!targetPath) {
                res.status(400).json({ error: 'Missing required field: path' });
                return;
            }

            if (!req.file) {
                res.status(400).json({ error: 'Missing required file upload' });
                return;
            }

            if (!validator.isPathAllowed(targetPath)) {
                res.status(403).json({ error: 'Access denied' });
                return;
            }

            const resolved = path.resolve(targetPath);

            // Ensure parent directory exists
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(resolved, req.file.buffer);
            res.json({ path: resolved, size: req.file.size });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // --------------------------------------------------------------- mkdir
    router.post('/mkdir', (req, res) => {
        try {
            const dirPath = req.body?.path as string | undefined;
            if (!dirPath) {
                res.status(400).json({ error: 'Missing required field: path' });
                return;
            }

            if (!validator.isPathAllowed(dirPath)) {
                res.status(403).json({ error: 'Access denied' });
                return;
            }

            const resolved = path.resolve(dirPath);
            fs.mkdirSync(resolved, { recursive: true });
            res.json({ path: resolved });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ----------------------------------------------------------------- rm
    router.delete('/rm', (req, res) => {
        try {
            const targetPath = req.query.path as string | undefined;
            if (!targetPath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            if (!validator.isPathAllowed(targetPath)) {
                res.status(403).json({ error: 'Access denied' });
                return;
            }

            const resolved = path.resolve(targetPath);
            if (!fs.existsSync(resolved)) {
                res.status(404).json({ error: 'Path not found' });
                return;
            }

            fs.rmSync(resolved, { recursive: true, force: true });
            res.json({ deleted: resolved });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    return router;
}
