import { Router } from 'express';

const SERVER_VERSION = '2.0.0';

export function createCliVersionController(): Router {
    const router = Router();

    router.get('/version', (_req, res) => {
        res.json({
            supportedVersions: [1, 2],
            preferredVersion: 2,
            serverVersion: SERVER_VERSION,
        });
    });

    return router;
}
