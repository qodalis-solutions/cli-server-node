import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
    IFileStorageProvider,
    FileNotFoundError,
    PermissionDeniedError,
    NotADirectoryError,
    IsADirectoryError,
    FileExistsError,
} from '../../plugins/filesystem';

/**
 * Maps provider errors to appropriate HTTP status codes and sends a JSON error response.
 */
function handleError(err: unknown, res: Response): void {
    if (err instanceof FileNotFoundError) {
        res.status(404).json({ error: err.message });
    } else if (err instanceof PermissionDeniedError) {
        res.status(403).json({ error: err.message });
    } else if (err instanceof NotADirectoryError || err instanceof IsADirectoryError) {
        res.status(400).json({ error: err.message });
    } else if (err instanceof FileExistsError) {
        res.status(409).json({ error: err.message });
    } else {
        res.status(500).json({ error: (err as Error).message });
    }
}

/**
 * Creates an Express router that exposes filesystem operations backed by
 * a pluggable `IFileStorageProvider`.
 */
export function createFilesystemRouter(provider: IFileStorageProvider): Router {
    const router = Router();

    const upload = multer({ storage: multer.memoryStorage() });

    // ------------------------------------------------------------------ ls
    router.get('/ls', async (req: Request, res: Response) => {
        try {
            const dirPath = req.query.path as string | undefined;
            if (!dirPath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            const entries = await provider.list(dirPath);
            res.json({ entries });
        } catch (err) {
            handleError(err, res);
        }
    });

    // ----------------------------------------------------------------- cat
    router.get('/cat', async (req: Request, res: Response) => {
        try {
            const filePath = req.query.path as string | undefined;
            if (!filePath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            const content = await provider.readFile(filePath);
            res.json({ content });
        } catch (err) {
            handleError(err, res);
        }
    });

    // ---------------------------------------------------------------- stat
    router.get('/stat', async (req: Request, res: Response) => {
        try {
            const filePath = req.query.path as string | undefined;
            if (!filePath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            const fileStat = await provider.stat(filePath);
            res.json(fileStat);
        } catch (err) {
            handleError(err, res);
        }
    });

    // ------------------------------------------------------------ download
    router.get('/download', async (req: Request, res: Response) => {
        try {
            const filePath = req.query.path as string | undefined;
            if (!filePath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            const stream = await provider.getDownloadStream(filePath);

            // Extract filename from the path for Content-Disposition header
            const filename = filePath.split('/').pop() || 'download';
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            stream.pipe(res);
        } catch (err) {
            handleError(err, res);
        }
    });

    // -------------------------------------------------------------- upload
    router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
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

            await provider.uploadFile(targetPath, req.file.buffer);
            res.json({ path: targetPath, size: req.file.size });
        } catch (err) {
            handleError(err, res);
        }
    });

    // --------------------------------------------------------------- mkdir
    router.post('/mkdir', async (req: Request, res: Response) => {
        try {
            const dirPath = req.body?.path as string | undefined;
            if (!dirPath) {
                res.status(400).json({ error: 'Missing required field: path' });
                return;
            }

            await provider.mkdir(dirPath, true);
            res.json({ path: dirPath });
        } catch (err) {
            handleError(err, res);
        }
    });

    // ----------------------------------------------------------------- rm
    router.delete('/rm', async (req: Request, res: Response) => {
        try {
            const targetPath = req.query.path as string | undefined;
            if (!targetPath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            await provider.remove(targetPath, true);
            res.json({ deleted: targetPath });
        } catch (err) {
            handleError(err, res);
        }
    });

    return router;
}
