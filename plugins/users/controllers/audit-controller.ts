import { Router, Request, Response } from 'express';
import { ICliAuditStore } from '../stores/interfaces';
import { AuthService } from '../services/auth-service';
import { getAuth, requirePermission } from '../middleware/auth-middleware';
import { asyncHandler, badRequest } from '../errors';
import { UsersPermissions as P } from '../permissions';

/** Audit entries returned when the request names no limit. */
export const DEFAULT_AUDIT_LIMIT = 100;

/** The most audit entries one request returns. */
export const MAX_AUDIT_LIMIT = 1000;

/** `/audit` resource. Expects the auth middleware to have run. */
export function createAuditController(auditStore: ICliAuditStore, authService: AuthService): Router {
    const router = Router();

    // GET / — audit:read, newest first (?event=&username=&actor=&limit=&offset=)
    router.get('/', requirePermission(P.AuditRead), asyncHandler(async (req: Request, res: Response) => {
        const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
        const count = (name: 'limit' | 'offset'): number | undefined => {
            const value = req.query[name];
            if (value === undefined || value === '') return undefined;
            if (typeof value !== 'string' || !/^\d+$/.test(value)) {
                throw badRequest(`${name} must be a non-negative integer`);
            }
            return parseInt(value, 10);
        };
        res.json(await auditStore.getEntries({
            event: text(req.query.event),
            username: text(req.query.username),
            actor: text(req.query.actor),
            // A database store never loads the whole log for one request
            limit: Math.min(count('limit') ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT),
            offset: count('offset'),
        }));
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
