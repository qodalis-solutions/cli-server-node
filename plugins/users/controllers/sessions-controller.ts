import { Router, Request, Response, RequestHandler } from 'express';
import { ICliUserStore } from '../stores/interfaces';
import { AuthService, toUserJson } from '../services/auth-service';
import { DirectoryService, bodyOf, callerOf } from '../services/directory-service';
import { can, getAuth, requirePermission } from '../middleware/auth-middleware';
import { asyncHandler, badRequest, forbidden, HttpError, notFound } from '../errors';
import { UsersPermissions as P } from '../permissions';

export interface SessionsControllerOptions {
    /** When true, login/logout return 501 (the host app owns authentication). */
    externalAuth?: boolean;
    /** Per-IP attempt limiter for login (throws 429). */
    limitAttempt?: (req: Request) => void;
}

const notAvailable = () => new HttpError(501, 'Authentication is managed by the host application');

/**
 * Sessions resource.
 *
 * - `POST   /`         — login (public)
 * - `GET    /current`  — current session
 * - `DELETE /current`  — logout
 * - `GET    /`         — list sessions (`sessions:read`)
 * - `DELETE /:id`      — revoke a session (`sessions:revoke` or own session)
 */
export function createSessionsController(
    authService: AuthService,
    userStore: ICliUserStore,
    directory: DirectoryService,
    authMiddleware: RequestHandler,
    options: SessionsControllerOptions = {},
): Router {
    const router = Router();
    const { externalAuth } = options;

    if (externalAuth) {
        router.post('/', asyncHandler(async () => { throw notAvailable(); }));
        router.delete('/current', asyncHandler(async () => { throw notAvailable(); }));
    } else {
        router.post('/', asyncHandler(async (req: Request, res: Response) => {
            const body = bodyOf(req);
            const { username, password } = body;
            if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
                throw badRequest('username and password are required');
            }
            if (username.length > 254 || password.length > 1024) {
                throw badRequest('username or password too long');
            }
            options.limitAttempt?.(req);
            const result = await authService.login(username.trim(), password, {
                remoteAddress: req.ip,
                userAgent: req.headers['user-agent'],
            });
            res.status(201).json(result);
        }));
    }

    router.use(authMiddleware);

    router.get('/current', asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        if (auth.apiToken) {
            throw notFound('not a session');
        }
        if (auth.session) {
            res.json(authService.toSessionPayload(auth.session, auth.user, auth.permissions));
            return;
        }
        // External-auth request: synthetic, unstored session
        const now = Date.now();
        res.json({
            id: `adapter:${auth.user.id}`,
            user: toUserJson(auth.user),
            permissions: auth.permissions,
            loginTime: now,
            lastActivity: now,
            expiresAt: now + authService.sessionTimeoutMs,
        });
    }));

    if (!externalAuth) {
        router.delete('/current', asyncHandler(async (req: Request, res: Response) => {
            const auth = getAuth(req);
            if (auth.apiToken) {
                throw notFound('not a session');
            }
            if (auth.tokenHash) {
                await authService.logout(auth.tokenHash);
            }
            res.status(204).end();
        }));
    }

    // POST /ws-ticket — single-use WebSocket ticket bound to this session (30 s)
    router.post('/ws-ticket', asyncHandler(async (req: Request, res: Response) => {
        res.status(201).json(authService.issueTicket(getAuth(req)));
    }));

    router.get('/', requirePermission(P.SessionsRead), asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const sessions = await authService.listSessions();
        const names = new Map<string, string>();
        for (const s of sessions) {
            if (!names.has(s.userId)) {
                names.set(s.userId, (await userStore.getUser(s.userId))?.name ?? s.userId);
            }
        }
        res.json(sessions.map((s) => authService.toSessionView(s, names.get(s.userId)!, auth.session?.id ?? '')));
    }));

    router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const session = await authService.getSessionById(req.params.id);
        if (!session) {
            throw notFound('session not found');
        }
        if (session.userId !== auth.user.id) {
            if (!can(req, P.SessionsRevoke)) {
                throw forbidden(`forbidden: missing permission ${P.SessionsRevoke}`);
            }
            const owner = await userStore.getUser(session.userId);
            if (owner) {
                await directory.assertCanActOn(callerOf(auth), owner);
            }
        }
        await authService.revokeSession(session, 'revoked', auth.user.name, undefined, auth.user.id);
        res.status(204).end();
    }));

    return router;
}
