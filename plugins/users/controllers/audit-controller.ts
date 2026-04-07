import { Router, Request, Response } from 'express';
import { ICliAuditStore } from '../stores/interfaces';
import { requireAdmin } from '../middleware/auth-middleware';

export function createAuditController(auditStore: ICliAuditStore): Router {
    const router = Router();

    // GET / — list audit entries (admin only), supports ?event=&username=&limit=
    router.get('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
        const event = req.query.event as string | undefined;
        const username = req.query.username as string | undefined;
        const limitStr = req.query.limit as string | undefined;
        const limit = limitStr ? parseInt(limitStr, 10) : undefined;

        const entries = await auditStore.getEntries({ event, username, limit });
        res.json(entries);
    });

    // DELETE / — clear all audit entries (admin only)
    router.delete('/', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
        await auditStore.clear();
        res.json({ message: 'Audit log cleared' });
    });

    return router;
}
