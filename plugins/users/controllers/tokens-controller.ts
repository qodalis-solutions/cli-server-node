import { Router, Request, Response } from 'express';
import { ICliUserStore } from '../stores/interfaces';
import { AuthService } from '../services/auth-service';
import { bodyOf } from '../services/directory-service';
import { can, getAuth } from '../middleware/auth-middleware';
import { asyncHandler, badRequest, forbidden } from '../errors';
import { UsersPermissions as P } from '../permissions';

/**
 * API tokens resource. Expects the auth middleware to have run.
 *
 * - `GET    /`          — own tokens (`?all=true` with `tokens:read`: every user's)
 * - `POST   /`          — create a token (session only) → `201 { token, apiToken }`
 * - `DELETE /:id`       — revoke (owner or `tokens:revoke`; otherwise 404)
 */
export function createTokensController(authService: AuthService, userStore: ICliUserStore): Router {
    const router = Router();

    router.get('/', asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const allParam = req.query.all;
        if (allParam !== undefined && allParam !== 'true' && allParam !== 'false') {
            throw badRequest('all must be true or false');
        }
        const all = allParam === 'true';
        if (all && !can(req, P.TokensRead)) {
            throw forbidden(`forbidden: missing permission ${P.TokensRead}`);
        }
        const tokens = await authService.listApiTokens(all ? undefined : auth.user.id);
        const names = new Map<string, string>([[auth.user.id, auth.user.name]]);
        for (const t of tokens) {
            if (!names.has(t.userId)) {
                names.set(t.userId, (await userStore.getUser(t.userId))?.name ?? t.userId);
            }
        }
        res.json(tokens.map((t) => authService.toApiTokenView(t, names.get(t.userId)!)));
    }));

    router.post('/', asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        if (auth.apiToken) {
            throw forbidden('forbidden: API tokens cannot create tokens');
        }
        const { token, apiToken } = await authService.createApiToken(auth, bodyOf(req));
        res.status(201).json({ token, apiToken: authService.toApiTokenView(apiToken, auth.user.name) });
    }));

    router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        await authService.revokeApiToken(auth, req.params.id, can(req, P.TokensRevoke));
        res.status(204).end();
    }));

    return router;
}
