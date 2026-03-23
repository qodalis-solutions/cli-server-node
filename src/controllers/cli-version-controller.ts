import { Router } from 'express';
import * as os from 'os';
import * as path from 'path';

const SERVER_VERSION = '2.0.0';

/**
 * Creates an Express router for API version discovery and server capabilities.
 * @returns Router with `/version` and `/capabilities` endpoints.
 */
export function createCliVersionController(): Router {
    const router = Router();

    router.get('/version', (_req, res) => {
        res.json({
            supportedVersions: [1, 2],
            preferredVersion: 2,
            serverVersion: SERVER_VERSION,
        });
    });

    router.get('/capabilities', (_req, res) => {
        const detectedOs = os.platform() === 'win32'
            ? 'win32'
            : os.platform() === 'darwin'
                ? 'darwin'
                : 'linux';

        const shell = os.platform() === 'win32' ? 'powershell' : 'bash';
        const shellPath = os.platform() === 'win32'
            ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
            : '/bin/bash';

        res.json({
            shell: true,
            os: detectedOs,
            shellPath,
            version: SERVER_VERSION,
        });
    });

    return router;
}
