import { Router, Request, Response } from 'express';
import { CLI_PLUGINS_INSTALL_PERMISSION, CLI_UPDATES_READ_PERMISSION, hasCliPermission } from '@qodalis/cli-server-abstractions';
import type { UpdateChecker } from '../services/update-checker';

/** True when the caller may see and check the updates: `updates:read` or `plugins:install` (anyone without sign-in). */
export function canReadUpdates(permissions: readonly string[] | undefined | null): boolean {
    if (!permissions) return true;
    return hasCliPermission(permissions, CLI_UPDATES_READ_PERMISSION) || hasCliPermission(permissions, CLI_PLUGINS_INSTALL_PERMISSION);
}

/**
 * `/api/v1/qcli/updates` (`updates:read` or `plugins:install` on a protected server):
 * - `GET /` → the last check's result (`checkedAt`, `checking`, `server`, `dashboardPlugins`, `serverPlugins`,
 *   `codePlugins`, `count`, `error?`);
 * - `POST /check` → checks now and answers the new result.
 */
export function createUpdatesController(checker: UpdateChecker): Router {
    const router = Router();
    router.use((req: Request, res: Response, next) => {
        const auth = (req as Request & { qcliServerAuth?: { permissions?: string[] } }).qcliServerAuth;
        if (auth && !canReadUpdates(auth.permissions ?? [])) {
            res.status(403).json({ error: `forbidden: missing permission ${CLI_UPDATES_READ_PERMISSION}` });
            return;
        }
        next();
    });

    router.get('/', (_req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(checker.result());
    });

    router.post('/check', async (_req: Request, res: Response) => {
        try {
            res.json(await checker.check());
        } catch (err) {
            res.status(502).json({ error: (err as Error)?.message ?? 'update check failed' });
        }
    });

    return router;
}
