import { Router, Request, Response } from 'express';
import { AuthService } from '../services/auth-service';
import { can, getAuth } from '../middleware/auth-middleware';
import { asyncHandler, badRequest, forbidden } from '../errors';
import { UsersPermissions as P, hasPermission } from '../permissions';

/**
 * Permission catalog resource. Expects the auth middleware to have run.
 *
 * - `GET /` — the catalog entries the caller holds (what they may put on a token);
 *   `?all=true` with `users:read`: every entry
 */
export function createPermissionsController(authService: AuthService): Router {
    const router = Router();

    router.get('/', asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const allParam = req.query.all;
        if (allParam !== undefined && allParam !== 'true' && allParam !== 'false') {
            throw badRequest('all must be true or false');
        }
        const all = allParam === 'true';
        if (all && !can(req, P.UsersRead)) {
            // Same text on every server (the other routes word this 403 differently)
            throw forbidden(`permission denied: ${P.UsersRead}`);
        }
        const entries = authService.permissionCatalog().all();
        res.json(
            entries
                .filter((p) => all || hasPermission(auth.permissions, p.name))
                .map((p) => ({ name: p.name, description: p.description, group: p.group, surface: p.surface })),
        );
    }));

    return router;
}
