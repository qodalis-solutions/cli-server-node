import { Router, Request, Response } from 'express';
import { hasCliPermission } from '@qodalis/cli-server-abstractions';
import type { AuthenticatedRequest } from '../auth/auth-middleware';
import {
    DASHBOARD_INSTALL_PERMISSION,
    DashboardMarketplace,
    DashboardMarketplaceActor,
    DashboardMarketplaceError,
} from '../services/dashboard-marketplace';

/** The caller as the users plugin's gate authenticated it (`req.qcliServerAuth` on a protected server). */
interface GateCaller {
    userId: string;
    userName: string;
    permissions: string[];
}

/** Who is asking and what they may do: the server's caller, else the dashboard session (the static admin may do everything). */
export function callerOf(req: Request): DashboardMarketplaceActor & { permissions: string[] } {
    const gate = (req as Request & { qcliServerAuth?: GateCaller }).qcliServerAuth;
    if (gate) return { userId: gate.userId, userName: gate.userName, permissions: gate.permissions ?? [] };
    const user = (req as AuthenticatedRequest).user;
    const permissions = Array.isArray(user?.permissions) ? (user!.permissions as string[]) : ['*'];
    return { userName: user?.username ?? 'admin', permissions };
}

export function sendError(res: Response, err: unknown): void {
    if (err instanceof DashboardMarketplaceError) {
        res.status(err.status).json({ error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
        return;
    }
    console.error('[qcli-admin] dashboard marketplace request failed:', (err as Error)?.message ?? err);
    res.status(500).json({ error: 'internal server error' });
}

/** A whole number query parameter in a range; undefined when absent, 400 when invalid. */
export function intParam(value: unknown, name: string, max: number): number | undefined {
    if (value === undefined || value === '') return undefined;
    const n = Number(value);
    if (typeof value !== 'string' || !Number.isInteger(n) || n < 1 || n > max) throw new DashboardMarketplaceError(400, `invalid ${name}`);
    return n;
}

/** The package name below `prefix` (`/installed/@acme/tickets` or `/installed/%40acme%2Ftickets`). */
export function nameBelow(req: Request, prefix: string): string {
    try {
        return decodeURIComponent(req.path.slice(prefix.length));
    } catch {
        throw new DashboardMarketplaceError(400, 'invalid package name');
    }
}

/**
 * Dashboard plugins from the marketplace (`/api/v1/qcli/dashboard/marketplace`): reading needs `admin:access`,
 * installing, updating and removing `dashboard:install`.
 *
 * - `GET /` — `{ marketplaceUrl, install, dashboardApi }`
 * - `GET /plugins?query=&page=&pageSize=` — the marketplace's dashboard plugins, annotated (`installed`, `updateAvailable`, `allowed`, `blockedReason`, `requires`)
 * - `GET /plugins/{name}` — one plugin with its versions
 * - `GET /installed` — the installed plugins (`updateAvailable` when the marketplace answers)
 * - `GET /installed/{name}/config` — `{ values, version }`: its settings' values (stored over defaults), the section's version
 * - `POST /installed` `{ name, version?, config? }` — 201 with the installed plugin (`warnings` when its settings were ignored)
 * - `PUT /installed/{name}` `{ version?, config? }` — the updated plugin with `configDropped`
 * - `DELETE /installed/{name}` — the removed plugin (its settings deleted)
 *
 * `config` (`{ key: value }`) is checked against the version's settings before anything is downloaded: 400
 * `{ error: 'validation failed', errors: { key: message } }`.
 */
export function createDashboardMarketplaceController(marketplace: DashboardMarketplace): Router {
    const router = Router();

    const canInstall = (req: Request, res: Response): DashboardMarketplaceActor | undefined => {
        const caller = callerOf(req);
        if (!hasCliPermission(caller.permissions, DASHBOARD_INSTALL_PERMISSION)) {
            res.status(403).json({ error: `forbidden: missing permission ${DASHBOARD_INSTALL_PERMISSION}` });
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
            res.json(await marketplace.search({ query, page, pageSize }));
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

    router.get(/^\/installed\/.+\/config$/, async (req, res) => {
        try {
            const name = nameBelow(req, '/installed/');
            res.json(await marketplace.pluginConfig(name.slice(0, -'/config'.length)));
        } catch (err) {
            sendError(res, err);
        }
    });

    router.post('/installed', async (req, res) => {
        const actor = canInstall(req, res);
        if (!actor) return;
        try {
            const body = (req.body ?? {}) as { name?: unknown; version?: unknown; config?: unknown };
            res.status(201).json(await marketplace.installPlugin(body.name, body.version, actor, body.config));
        } catch (err) {
            sendError(res, err);
        }
    });

    router.put(/^\/installed\/.+/, async (req, res) => {
        const actor = canInstall(req, res);
        if (!actor) return;
        try {
            const body = (req.body ?? {}) as { version?: unknown; config?: unknown };
            const result = await marketplace.updatePlugin(nameBelow(req, '/installed/'), body.version, actor, body.config);
            res.json({ ...result.plugin, configDropped: result.configDropped, ...(result.warnings ? { warnings: result.warnings } : {}) });
        } catch (err) {
            sendError(res, err);
        }
    });

    router.delete(/^\/installed\/.+/, async (req, res) => {
        const actor = canInstall(req, res);
        if (!actor) return;
        try {
            res.json(await marketplace.removePlugin(nameBelow(req, '/installed/'), actor));
        } catch (err) {
            sendError(res, err);
        }
    });

    return router;
}
