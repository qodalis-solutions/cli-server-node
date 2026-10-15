import { Router } from 'express';
import * as os from 'os';
import * as path from 'path';

const SERVER_VERSION = '2.0.0';

/** Shell part of `/capabilities`: `shellAuth` only when the shell is enabled. */
export interface ShellCapabilities {
    shell: boolean;
    shellAuth?: 'users' | 'token' | 'custom' | 'anonymous' | 'locked';
}

export interface CapabilitiesOptions {
    /** Live shell state; when omitted `/capabilities` reports `shell: true` (legacy). */
    shellCapabilities?: () => ShellCapabilities;
}

/** Resolves the shell fields of `/capabilities`. */
export function resolveShellCapabilities(options?: CapabilitiesOptions): ShellCapabilities {
    return options?.shellCapabilities ? options.shellCapabilities() : { shell: true };
}

/**
 * Creates an Express router for API version discovery and server capabilities.
 * @returns Router with `/versions` and `/capabilities` endpoints.
 */
export function createCliVersionController(options?: CapabilitiesOptions): Router {
    const router = Router();

    router.get('/versions', (_req, res) => {
        res.json({
            supportedVersions: [1],
            preferredVersion: 1,
            serverVersion: SERVER_VERSION,
        });
    });

    router.get('/version', (_req, res) => {
        res.redirect(301, 'versions');
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
            ...resolveShellCapabilities(options),
            os: detectedOs,
            shellPath,
            version: SERVER_VERSION,
            streaming: true,
        });
    });

    return router;
}
