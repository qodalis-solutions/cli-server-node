import { Router, Request, Response } from 'express';
import { ICliUserStore, ICliCredentialStore, ICliSessionStore } from '../stores/interfaces';
import { AuthService } from '../services/auth-service';
import { requireAdmin } from '../middleware/auth-middleware';

export interface UsersControllerOptions {
    /** When true, authentication is managed by the host app: verify-password returns 501 */
    externalAuth?: boolean;
}

export function createUsersController(
    userStore: ICliUserStore,
    authService: AuthService,
    credentialStore: ICliCredentialStore,
    sessionStore: ICliSessionStore,
    options: UsersControllerOptions = {},
): Router {
    const router = Router();

    // GET / — list all users
    router.get('/', async (_req: Request, res: Response): Promise<void> => {
        const users = await userStore.getUsers();
        res.json(users);
    });

    // GET /:idOrName — get user by id or name
    router.get('/:idOrName', async (req: Request, res: Response): Promise<void> => {
        const user = await userStore.getUser(req.params.idOrName);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json(user);
    });

    // POST / — create user (admin only)
    router.post('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        const { name, email, password, groups, data } = req.body ?? {};
        if (!name || !email) {
            res.status(400).json({ error: 'name and email are required' });
            return;
        }

        try {
            const user = await userStore.createUser({ name, email, groups, data });
            if (password) {
                await authService.setPassword(user.id, password);
            }
            res.status(201).json(user);
        } catch (err: any) {
            res.status(409).json({ error: err.message });
        }
    });

    // PUT /:id — update user (admin only)
    router.put('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        const { name, email, groups, disabled, data } = req.body ?? {};
        try {
            const user = await userStore.updateUser(req.params.id, { name, email, groups, disabled, data });
            res.json(user);
        } catch (err: any) {
            res.status(404).json({ error: err.message });
        }
    });

    // DELETE /:id — delete user (admin only)
    router.delete('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        await userStore.deleteUser(req.params.id);
        await credentialStore.deleteCredentials(req.params.id);
        await sessionStore.deleteUserSessions(req.params.id);
        res.status(204).end();
    });

    // PUT /:id/password — change password (self or admin)
    router.put('/:id/password', async (req: Request, res: Response): Promise<void> => {
        const requestingUser = req.session?.user;
        const targetId = req.params.id;

        const isSelf = requestingUser?.id === targetId;
        const isAdmin = requestingUser?.groups?.includes('admin') ?? false;

        if (!isSelf && !isAdmin) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }

        const { currentPassword, newPassword } = req.body ?? {};
        if (!newPassword) {
            res.status(400).json({ error: 'newPassword is required' });
            return;
        }

        if (isSelf && !isAdmin) {
            if (!currentPassword) {
                res.status(400).json({ error: 'currentPassword is required' });
                return;
            }
            const valid = await authService.verifyPassword(targetId, currentPassword);
            if (!valid) {
                // 403, not 401: the session is valid, the supplied password is not
                res.status(403).json({ error: 'Current password is incorrect' });
                return;
            }
        }

        try {
            await authService.setPassword(targetId, newPassword);
            res.json({ message: 'Password updated' });
        } catch (err: any) {
            res.status(400).json({ error: err.message });
        }
    });

    // POST /:id/verify-password — check a user's password, returns { valid }.
    // Requires an authenticated session (used by `su` and `passwd` on the client).
    router.post('/:id/verify-password', async (req: Request, res: Response): Promise<void> => {
        if (options.externalAuth) {
            res.status(501).json({ error: 'Authentication is managed by the host application' });
            return;
        }
        const { password } = req.body ?? {};
        if (!password) {
            res.status(400).json({ error: 'password is required' });
            return;
        }
        const valid = await authService.verifyPassword(req.params.id, password);
        res.json({ valid });
    });

    return router;
}
