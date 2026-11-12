import { Router, Request, Response, RequestHandler } from 'express';
import { LinkService } from '../services/link-service';
import { bodyOf } from '../services/directory-service';
import { getAuth } from '../middleware/auth-middleware';
import { asyncHandler, HttpError } from '../errors';
import { clientIp, RateLimiter } from '../security';

/** Link requests created per client address and minute at most. */
export const LINK_CREATE_RATE_LIMIT = 10;

/**
 * Link requests (`server add` in the web CLI, through the browser):
 *
 * - `POST /`                       — a terminal asks to be linked (public, rate limited) → `201 { linkId, userCode, verificationUrl, expiresIn, interval }`
 * - `GET  /:linkId`                — the terminal polls (public) → `{ status }`, the token once approved; 404 `{ status: 'expired' }`
 * - `GET  /code/:userCode`         — the approval page reads the request (signed in)
 * - `POST /code/:userCode/approve` — creates the approver's API token for the terminal (a session, or the host's sign-in with `apiTokensWithExternalAuth`)
 * - `POST /code/:userCode/deny`
 */
export function createLinkController(
    links: LinkService,
    authMiddleware: RequestHandler,
    options: { trustProxy: boolean | number; limiter?: RateLimiter },
): Router {
    const router = Router();
    // The caller sweeps it (the plugin's cleanup timer), so addresses seen once are not kept forever
    const limiter = options.limiter ?? new RateLimiter(LINK_CREATE_RATE_LIMIT, 60_000);

    router.post('/', asyncHandler(async (req: Request, res: Response) => {
        const ip = clientIp(req, options.trustProxy);
        if (!limiter.tryAcquire(ip)) {
            throw new HttpError(429, 'too many link requests, try again later');
        }
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        res.status(201).json(links.create(bodyOf(req), origin, ip));
    }));

    router.get('/code/:code', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
        res.json(links.view(req.params.code));
    }));

    router.post('/code/:code/approve', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
        res.json(await links.approve(getAuth(req), req.params.code));
    }));

    router.post('/code/:code/deny', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
        await links.deny(getAuth(req), req.params.code);
        res.status(204).end();
    }));

    router.get('/:linkId', asyncHandler(async (req: Request, res: Response) => {
        const result = links.poll(req.params.linkId);
        if (!result) {
            res.status(404).json({ status: 'expired' });
            return;
        }
        res.set('Cache-Control', 'no-store').json(result);
    }));

    return router;
}
