import { Router, Request, Response } from 'express';
import {
    cliConfigContext,
    isCliConfigError,
    type CliConfigContext,
    type ICliConfigService,
} from '@qodalis/cli-server-abstractions';
import type { AuthenticatedRequest } from '../auth/auth-middleware';

/** The caller as the users plugin's gate authenticated it (`req.qcliServerAuth` on a protected server). */
interface GateCaller {
    userId: string;
    userName: string;
    permissions: string[];
}

/**
 * Who is asking: the server's caller on a protected server, else the dashboard session (a users
 * session carries its permissions; the static admin of password mode may do everything).
 */
export function configContextOf(req: Request): CliConfigContext {
    const gate = (req as Request & { qcliServerAuth?: GateCaller }).qcliServerAuth;
    if (gate) return cliConfigContext({ userId: gate.userId, userName: gate.userName, permissions: gate.permissions }, 'api');
    const user = (req as AuthenticatedRequest).user;
    const permissions = Array.isArray(user?.permissions) ? (user!.permissions as string[]) : ['*'];
    return cliConfigContext({ userName: user?.username ?? 'admin', permissions }, 'api');
}

function sendError(res: Response, err: unknown): void {
    if (isCliConfigError(err)) {
        res.status(err.status).json(err.toJSON());
        return;
    }
    console.error('[qcli-admin] config request failed:', (err as Error)?.message ?? err);
    res.status(500).json({ error: 'internal server error' });
}

/**
 * The config API over the server's config providers (`builder.config`):
 *
 * - `GET /` — `{ store, providers: [...] }`: where changes are saved, and the providers the caller may see (`config:read`)
 * - `GET /:provider` — one provider
 * - `PATCH /:provider/:section` — `{ changes, version? }` (`config:write`): 200 with the section,
 *   400 `{ error, errors }` per key, 403, 404, 409 `{ error, version }` when the version is stale
 */
export function createConfigController(getService: () => ICliConfigService | undefined): Router {
    const router = Router();

    const service = (res: Response): ICliConfigService | undefined => {
        const s = getService();
        if (!s) res.status(404).json({ error: 'config providers are not available on this server' });
        return s;
    };

    router.get('/', async (req: Request, res: Response) => {
        const s = service(res);
        if (!s) return;
        try {
            res.setHeader('Cache-Control', 'no-store');
            const providers = await s.list(configContextOf(req));
            res.json({ store: s.describeStore(), providers });
        } catch (err) {
            sendError(res, err);
        }
    });

    router.get('/:provider', async (req: Request, res: Response) => {
        const s = service(res);
        if (!s) return;
        try {
            res.setHeader('Cache-Control', 'no-store');
            res.json(await s.get(req.params.provider, configContextOf(req)));
        } catch (err) {
            sendError(res, err);
        }
    });

    router.patch('/:provider/:section', async (req: Request, res: Response) => {
        const s = service(res);
        if (!s) return;
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            res.status(400).json({ error: 'Request body must be a JSON object' });
            return;
        }
        try {
            res.json(await s.update(req.params.provider, req.params.section, { changes: body.changes, version: body.version }, configContextOf(req)));
        } catch (err) {
            sendError(res, err);
        }
    });

    return router;
}
