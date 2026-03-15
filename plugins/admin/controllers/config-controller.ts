import { Router, Request, Response } from 'express';
import { AdminConfig } from '../services/admin-config';

/**
 * Creates the config controller router.
 *
 * Routes:
 * - GET / — return structured config sections
 * - PUT / — update mutable settings
 */
export function createConfigController(config: AdminConfig): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response): void => {
        res.json(config.getConfigSections());
    });

    router.put('/', (req: Request, res: Response): void => {
        const body = req.body;

        if (!body || typeof body !== 'object') {
            res.status(400).json({ error: 'Request body must be a JSON object' });
            return;
        }

        config.updateMutableSettings(body);
        res.json({
            message: 'Settings updated',
            settings: config.getMutableSettings(),
        });
    });

    return router;
}
