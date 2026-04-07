import { Router, Request, Response } from 'express';
import { ICliUserStore } from '../stores/interfaces';
import { AuthService } from '../services/auth-service';
import { requireAdmin } from '../middleware/auth-middleware';

export function createUsersController(
    userStore: ICliUserStore,
    authService: AuthService,
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
        res.json({ message: 'User deleted' });
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

        const { password } = req.body ?? {};
        if (!password) {
            res.status(400).json({ error: 'password is required' });
            return;
        }

        try {
            await authService.setPassword(targetId, password);
            res.json({ message: 'Password updated' });
        } catch (err: any) {
            res.status(400).json({ error: err.message });
        }
    });

    return router;
}
