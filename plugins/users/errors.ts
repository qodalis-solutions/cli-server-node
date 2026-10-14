import { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';

/** An error carrying an HTTP status; rendered as `{ error: message }`. */
export class HttpError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = 'HttpError';
    }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = 'unauthorized') => new HttpError(401, msg);
export const forbidden = (msg = 'forbidden') => new HttpError(403, msg);
export const notFound = (msg: string) => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

/** Wraps an async handler so rejections are forwarded to the error handler. */
export function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
    return (req, res, next) => {
        Promise.resolve()
            .then(() => fn(req, res, next))
            .catch(next);
    };
}

/** Renders every error as `{ error }` with the proper status. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) {
        return;
    }
    if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
    }
    // body-parser errors (malformed JSON, payload too large) carry a status
    const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
        res.status(status).json({ error: err?.type === 'entity.parse.failed' ? 'invalid JSON body' : String(err?.message ?? 'bad request') });
        return;
    }
    console.error('[users] unhandled error:', err);
    res.status(500).json({ error: 'internal server error' });
};
