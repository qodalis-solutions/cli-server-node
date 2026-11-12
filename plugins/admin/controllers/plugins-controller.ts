import { Router, Request, Response } from 'express';
import { ModuleRegistry } from '../services/module-registry';
import type { CliInstalledPlugin } from '../services/package-info';

/**
 * Creates the plugins controller router.
 *
 * Routes:
 * - GET  /          — list all registered modules (and the groups of commands added on their own)
 * - GET  /:id       — one module (case-insensitive id)
 * - GET  /installed — list the installed server plugin packages (id, name, version, description)
 * - POST /:id/toggle — toggle a module enabled/disabled
 */
export function createPluginsController(
    moduleRegistry: ModuleRegistry,
    installedPlugins: () => ReadonlyArray<CliInstalledPlugin> = () => [],
): Router {
    const router = Router();

    // Before any /:id route
    router.get('/installed', (_req: Request, res: Response): void => {
        res.json(installedPlugins());
    });

    router.get('/', (_req: Request, res: Response): void => {
        res.json(moduleRegistry.list());
    });

    router.get('/:id', (req: Request, res: Response): void => {
        const { id } = req.params;
        const result = moduleRegistry.getById(id);
        if (!result) {
            res.status(404).json({ error: `Module '${id}' not found` });
            return;
        }
        res.json(result);
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
