import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import {
    IFileStorageProvider,
    FileNotFoundError,
    PermissionDeniedError,
    NotADirectoryError,
    IsADirectoryError,
    FileExistsError,
} from '@qodalis/cli-server-plugin-filesystem';
import { createLogger } from '../utils/logger';
import { DEFAULT_MAX_UPLOAD_BYTES, FileSystemApiOptions } from '../filesystem/filesystem-options';

const logger = createLogger('FileSystem');

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
 * Multipart parser for `POST /upload`: one file of at most `maxUploadBytes`
 * (held in memory). Limit violations are answered as JSON: `413` for a file
 * that is too large, `400` for other malformed uploads (extra files, unexpected
 * fields), instead of reaching the default error handler as a `500`.
 */
function createUploadParser(maxUploadBytes: number): RequestHandler {
    // One byte of headroom: busboy may flag a file of exactly `fileSize` bytes as
    // truncated depending on chunk boundaries; the exact limit is checked below.
    const single = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxUploadBytes + 1, files: 1 },
    }).single('file');
    const tooLarge = (res: Response) => {
        logger.warn('Upload refused: file larger than %d bytes', maxUploadBytes);
        res.status(413).json({ error: `File too large: the upload limit is ${maxUploadBytes} bytes` });
    };

    return (req: Request, res: Response, next: NextFunction) => {
        single(req, res, (err?: unknown) => {
            if (!err) {
                if (req.file && req.file.size > maxUploadBytes) {
                    tooLarge(res);
                    return;
                }
                next();
                return;
            }
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    tooLarge(res);
                } else if (err.code === 'LIMIT_FILE_COUNT') {
                    res.status(400).json({ error: 'Only one file can be uploaded per request' });
                } else {
                    res.status(400).json({ error: `Invalid upload: ${err.message}` });
                }
                return;
            }
            next(err);
        });
    };
}

/**
 * Creates an Express router that exposes filesystem operations backed by
 * a pluggable `IFileStorageProvider`.
 */
export function createFilesystemRouter(provider: IFileStorageProvider, options: FileSystemApiOptions = {}): Router {
    const router = Router();

    const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (!Number.isFinite(maxUploadBytes) || maxUploadBytes <= 0) {
        throw new Error(`maxUploadBytes must be a positive number of bytes (got ${maxUploadBytes})`);
    }
    const upload = createUploadParser(maxUploadBytes);

    router.get('/ls', async (req: Request, res: Response) => {
        try {
            const dirPath = req.query.path as string | undefined;
            logger.debug('ls path=%s', dirPath);
            if (!dirPath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            const entries = await provider.list(dirPath);
            res.json({ entries });
        } catch (err) {
            if (err instanceof PermissionDeniedError) {
                logger.warn('Failed to ls: %s', (err as Error).message ?? err);
            } else {
                logger.error('Failed to ls: %s', (err as Error).message ?? err);
            }
            handleError(err, res);
        }
    });

    router.get('/cat', async (req: Request, res: Response) => {
        try {
            const filePath = req.query.path as string | undefined;
            logger.debug('cat path=%s', filePath);
            if (!filePath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            const content = await provider.readFile(filePath);
            res.json({ content });
        } catch (err) {
            if (err instanceof PermissionDeniedError) {
                logger.warn('Failed to cat: %s', (err as Error).message ?? err);
            } else {
                logger.error('Failed to cat: %s', (err as Error).message ?? err);
            }
            handleError(err, res);
        }
    });

    router.get('/stat', async (req: Request, res: Response) => {
        try {
            const filePath = req.query.path as string | undefined;
            logger.debug('stat path=%s', filePath);
            if (!filePath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            const fileStat = await provider.stat(filePath);
            res.json(fileStat);
        } catch (err) {
            if (err instanceof PermissionDeniedError) {
                logger.warn('Failed to stat: %s', (err as Error).message ?? err);
            } else {
                logger.error('Failed to stat: %s', (err as Error).message ?? err);
            }
            handleError(err, res);
        }
    });

    router.get('/download', async (req: Request, res: Response) => {
        try {
            const filePath = req.query.path as string | undefined;
            logger.debug('download path=%s', filePath);
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
            if (err instanceof PermissionDeniedError) {
                logger.warn('Failed to download: %s', (err as Error).message ?? err);
            } else {
                logger.error('Failed to download: %s', (err as Error).message ?? err);
            }
            handleError(err, res);
        }
    });

    router.post('/upload', upload, async (req: Request, res: Response) => {
        try {
            const targetPath = req.body?.path as string | undefined;
            logger.debug('upload path=%s', targetPath);
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
            if (err instanceof PermissionDeniedError) {
                logger.warn('Failed to upload: %s', (err as Error).message ?? err);
            } else {
                logger.error('Failed to upload: %s', (err as Error).message ?? err);
            }
            handleError(err, res);
        }
    });

    router.post('/mkdir', async (req: Request, res: Response) => {
        try {
            const dirPath = req.body?.path as string | undefined;
            logger.debug('mkdir path=%s', dirPath);
            if (!dirPath) {
                res.status(400).json({ error: 'Missing required field: path' });
                return;
            }

            await provider.mkdir(dirPath, true);
            res.json({ path: dirPath });
        } catch (err) {
            if (err instanceof PermissionDeniedError) {
                logger.warn('Failed to mkdir: %s', (err as Error).message ?? err);
            } else {
                logger.error('Failed to mkdir: %s', (err as Error).message ?? err);
            }
            handleError(err, res);
        }
    });

    router.delete('/rm', async (req: Request, res: Response) => {
        try {
            const targetPath = req.query.path as string | undefined;
            logger.debug('rm path=%s', targetPath);
            if (!targetPath) {
                res.status(400).json({ error: 'Missing required query parameter: path' });
                return;
            }

            await provider.remove(targetPath, true);
            res.json({ deleted: targetPath });
        } catch (err) {
            if (err instanceof PermissionDeniedError) {
                logger.warn('Failed to rm: %s', (err as Error).message ?? err);
            } else {
                logger.error('Failed to rm: %s', (err as Error).message ?? err);
            }
            handleError(err, res);
        }
    });

    return router;
}
