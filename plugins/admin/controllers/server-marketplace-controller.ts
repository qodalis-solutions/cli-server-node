import { Router, Request, Response } from 'express';
import { hasCliPermission } from '@qodalis/cli-server-abstractions';
import { DashboardMarketplaceActor } from '../services/dashboard-marketplace';
import { PLUGINS_INSTALL_PERMISSION, ServerPluginMarketplace } from '../services/server-plugin-marketplace';
import { callerOf, intParam, nameBelow, sendError } from './dashboard-marketplace-controller';

/**
 * Server plugins from the marketplace (`/api/v1/qcli/server/marketplace`): reading needs `admin:access`, installing,
 * updating and removing `plugins:install`. Every change takes effect after a restart: 202 with `restartRequired`.
 *
 * - `GET /` — `{ marketplaceUrl, install, platform: 'node', serverVersion, enabled }`
 * - `GET /plugins?query=&page=&pageSize=&platform=` — the marketplace's server plugins, annotated (`platform`,
 *   `otherPlatforms`, `autoInstall`, `updateAvailable`, `allowed`, `blockedReason`); `platform`: `this` (default: the
 *   ones with a Node package), `all`, `node`, `python` or `dotnet` (400 for anything else). Plugins without a Node
 *   package are not installable here.
 * - `GET /plugins/{name}` — one plugin with its platforms and versions
 * - `GET /installed` — the installed plugins and how they run (`status`, `loadedVersion`, `error`, `updateAvailable`)
 * - `POST /installed` `{ name, version? }` — 202, the installed plugin with `restartRequired`
 * - `PUT /installed/{name}` `{ version? }` — 202 (200 with `changed: false` when it already is that version)
 * - `DELETE /installed/{name}` — 202, the removed plugin
 */
export function createServerMarketplaceController(marketplace: ServerPluginMarketplace): Router {
    const router = Router();

    const canInstall = (req: Request, res: Response): DashboardMarketplaceActor | undefined => {
        const caller = callerOf(req);
        if (!hasCliPermission(caller.permissions, PLUGINS_INSTALL_PERMISSION)) {
            res.status(403).json({ error: `forbidden: missing permission ${PLUGINS_INSTALL_PERMISSION}` });
            return undefined;
        }
        return { ...(caller.userId ? { userId: caller.userId } : {}), userName: caller.userName };
    };

    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    router.get('/', (_req, res) => {
        res.json(marketplace.info());
    });

    router.get('/plugins', async (req, res) => {
        try {
            const query = typeof req.query.query === 'string' ? req.query.query : undefined;
            const page = intParam(req.query.page, 'page', 1_000_000);
            const pageSize = intParam(req.query.pageSize, 'pageSize', 100);
            const platform = req.query.platform === undefined ? undefined : typeof req.query.platform === 'string' ? req.query.platform : '?';
            res.json(await marketplace.search({ query, page, pageSize, platform }));
        } catch (err) {
            sendError(res, err);
        }
    });

    router.get(/^\/plugins\/.+/, async (req, res) => {
        try {
            res.json(await marketplace.details(nameBelow(req, '/plugins/')));
        } catch (err) {
            sendError(res, err);
        }
    });

    router.get('/installed', async (_req, res) => {
        try {
            res.json(await marketplace.installed({ checkUpdates: true }));
        } catch (err) {
            sendError(res, err);
        }
    });

    router.post('/installed', async (req, res) => {
        const actor = canInstall(req, res);
        if (!actor) return;
        try {
            const body = (req.body ?? {}) as { name?: unknown; version?: unknown };
            res.status(202).json(await marketplace.installPlugin(body.name, body.version, actor));
        } catch (err) {
            sendError(res, err);
        }
    });

    router.put(/^\/installed\/.+/, async (req, res) => {
        const actor = canInstall(req, res);
        if (!actor) return;
        try {
            const body = (req.body ?? {}) as { version?: unknown };
            const result = await marketplace.updatePlugin(nameBelow(req, '/installed/'), body.version, actor);
            res.status(result.changed === false ? 200 : 202).json(result);
        } catch (err) {
            sendError(res, err);
        }
    });

    router.delete(/^\/installed\/.+/, async (req, res) => {
        const actor = canInstall(req, res);
        if (!actor) return;
        try {
            res.status(202).json(await marketplace.removePlugin(nameBelow(req, '/installed/'), actor));
        } catch (err) {
            sendError(res, err);
        }
    });

    return router;
}
