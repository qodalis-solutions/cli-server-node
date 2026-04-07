import { Router, Request, Response } from 'express';
import { ICliGroupStore, ICliUserStore } from '../stores/interfaces';
import { requireAdmin } from '../middleware/auth-middleware';

export function createGroupsController(
    groupStore: ICliGroupStore,
    userStore: ICliUserStore,
): Router {
    const router = Router();

    // GET / — list all groups
    router.get('/', async (_req: Request, res: Response): Promise<void> => {
        const groups = await groupStore.getGroups();
        res.json(groups);
    });

    // GET /:name — get group by name
    router.get('/:name', async (req: Request, res: Response): Promise<void> => {
        const group = await groupStore.getGroup(req.params.name);
        if (!group) {
            res.status(404).json({ error: 'Group not found' });
            return;
        }
        res.json(group);
    });

    // POST / — create group (admin only)
    router.post('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        const { name, description } = req.body ?? {};
        if (!name) {
            res.status(400).json({ error: 'name is required' });
            return;
        }

        try {
            const group = await groupStore.createGroup(name, description);
            res.status(201).json(group);
        } catch (err: any) {
            res.status(409).json({ error: err.message });
        }
    });

    // DELETE /:name — delete group (admin only)
    router.delete('/:name', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        await groupStore.deleteGroup(req.params.name);
        res.json({ message: 'Group deleted' });
    });

    // PUT /:name/members/:userId — add user to group (admin only)
    router.put('/:name/members/:userId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        const { name, userId } = req.params;

        const group = await groupStore.getGroup(name);
        if (!group) {
            res.status(404).json({ error: 'Group not found' });
            return;
        }

        const user = await userStore.getUser(userId);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        if (!user.groups.includes(name)) {
            await userStore.updateUser(userId, { groups: [...user.groups, name] });
        }

        res.json({ message: `User added to group '${name}'` });
    });

    // DELETE /:name/members/:userId — remove user from group (admin only)
    router.delete('/:name/members/:userId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        const { name, userId } = req.params;

        const user = await userStore.getUser(userId);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        await userStore.updateUser(userId, { groups: user.groups.filter((g) => g !== name) });

        res.json({ message: `User removed from group '${name}'` });
    });

    return router;
}
