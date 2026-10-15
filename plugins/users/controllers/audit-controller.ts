import { Router, Request, Response } from 'express';
import { ICliAuditStore } from '../stores/interfaces';
import { AuthService } from '../services/auth-service';
import { getAuth, requirePermission } from '../middleware/auth-middleware';
import { asyncHandler, badRequest } from '../errors';
import { UsersPermissions as P } from '../permissions';

/** `/audit` resource. Expects the auth middleware to have run. */
export function createAuditController(auditStore: ICliAuditStore, authService: AuthService): Router {
    const router = Router();

    // GET / — audit:read (?limit=&event=&username=)
    router.get('/', requirePermission(P.AuditRead), asyncHandler(async (req: Request, res: Response) => {
        const event = typeof req.query.event === 'string' && req.query.event ? req.query.event : undefined;
        const username = typeof req.query.username === 'string' && req.query.username ? req.query.username : undefined;
        let limit: number | undefined;
        if (req.query.limit !== undefined && req.query.limit !== '') {
            if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) {
                throw badRequest('limit must be a non-negative integer');
            }
            limit = parseInt(req.query.limit, 10);
        }
        res.json(await auditStore.getEntries({ event, username, limit }));
    }));

    // DELETE / — audit:clear
    router.delete('/', requirePermission(P.AuditClear), asyncHandler(async (req: Request, res: Response) => {
        const actor = getAuth(req).user.name;
        await auditStore.clear();
        await authService.audit({ event: 'audit_cleared', username: actor, actor });
        res.status(204).end();
    }));

    return router;
}
