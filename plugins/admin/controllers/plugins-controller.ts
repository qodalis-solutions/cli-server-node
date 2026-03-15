import { Router, Request, Response } from 'express';
import { ModuleRegistry } from '../services/module-registry';

/**
 * Creates the plugins controller router.
 *
 * Routes:
 * - GET  /          — list all registered modules
 * - POST /:id/toggle — toggle a module enabled/disabled
 */
export function createPluginsController(moduleRegistry: ModuleRegistry): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response): void => {
        res.json(moduleRegistry.list());
    });

    router.post('/:id/toggle', (req: Request, res: Response): void => {
        const { id } = req.params;
        const result = moduleRegistry.toggle(id);

        if (!result) {
            res.status(404).json({ error: `Module '${id}' not found` });
            return;
        }

        res.json(result);
    });

    return router;
}
