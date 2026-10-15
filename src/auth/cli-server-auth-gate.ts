import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ICliCommandProcessor } from '../abstractions';
import { ICliCommandRegistry } from '../services/cli-command-registry';
import { CliServerAuthContext, CliServerPermissions as P, ICliServerAuth } from './cli-server-auth';
import { createLogger } from '../utils/logger';

const logger = createLogger('ServerAuth');

declare global {
    namespace Express {
        interface Request {
            /** Set by the server auth gate when the users plugin protects the server. */
            qcliServerAuth?: CliServerAuthContext;
        }
    }
}

/** Normalizes a request path for classification: lower-case, single slashes, no trailing slash. */
export function normalizePath(path: string): string {
    const p = path.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return p || '/';
}

const PUBLIC_GET = new Set([
    '/api/qcli/versions',
    '/api/qcli/version',
    '/api/qcli/capabilities',
    '/api/cli/versions',
    '/api/v1/qcli/version',
    '/api/v1/qcli/capabilities',
    '/health',
    '/healthz',
    '/api/health',
]);

const FS_READ = new Set(['ls', 'cat', 'stat', 'download']);

export interface ServerAuthGateOptions {
    registry: ICliCommandRegistry;
    /** Prefixes serving the CLI controller (`/api/v1/qcli`, custom basePath). */
    cliPrefixes: string[];
    /** Extra public routes as `"METHOD /path"` (e.g. a plugin's own login). */
    publicRoutes: Set<string>;
}

/** Collects `requiredPermissions` along the resolved processor chain. */
export function processorPermissions(
    registry: ICliCommandRegistry,
    command: unknown,
    chain: unknown,
): string[] {
    if (typeof command !== 'string') return [];
    const root = registry.processors.find((p) => p.command.toLowerCase() === command.toLowerCase());
    if (!root) return [];
    const out: string[] = [...(root.requiredPermissions ?? [])];
    let current: ICliCommandProcessor = root;
    if (Array.isArray(chain)) {
        for (const sub of chain) {
            if (typeof sub !== 'string') break;
            const child: ICliCommandProcessor | undefined = current.processors?.find(
                (p) => p.command.toLowerCase() === sub.toLowerCase(),
            );
            if (!child) break;
            out.push(...(child.requiredPermissions ?? []));
            current = child;
        }
    }
    return out;
}

/** Permissions required for a (protected) server route. */
export function requiredServerPermissions(method: string, path: string, body: any, options: ServerAuthGateOptions): string[] {
    for (const prefix of options.cliPrefixes) {
        if (path === `${prefix}/execute` || path === `${prefix}/execute/stream`) {
            return [P.CommandsExecute, ...processorPermissions(options.registry, body?.command, body?.chainCommands)];
        }
    }
    if (path === '/api/qcli/fs' || path.startsWith('/api/qcli/fs/')) {
        const op = path.slice('/api/qcli/fs/'.length);
        return [method === 'GET' && FS_READ.has(op) ? P.FilesRead : P.FilesWrite];
    }
    if (path === '/api/qcli/data-explorer' || path.startsWith('/api/qcli/data-explorer/')) {
        return [P.DataQuery];
    }
    if (path === '/api/v1/qcli/jobs' || path.startsWith('/api/v1/qcli/jobs/')) {
        return [method === 'GET' ? P.JobsRead : P.JobsManage];
    }
    return [];
}

/**
 * Express middleware protecting every `/api/...` route of the CLI server when
 * an auth provider with `protectServer` is installed. Without a provider it is
 * a no-op, so servers without the users plugin behave as before.
 */
export function createServerAuthGate(
    getAuth: () => ICliServerAuth | undefined,
    options: ServerAuthGateOptions,
): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const auth = getAuth();
        if (!auth || !auth.protectServer) {
            next();
            return;
        }
        const method = req.method.toUpperCase();
        if (method === 'OPTIONS') {
            next();
            return;
        }
        const path = normalizePath(req.path);
        if (!path.startsWith('/api/') && path !== '/api') {
            next();
            return;
        }
        if ((method === 'GET' || method === 'HEAD') && PUBLIC_GET.has(path)) {
            next();
            return;
        }
        if (options.publicRoutes.has(`${method} ${path}`) || auth.handlesPath(path, method)) {
            next();
            return;
        }

        auth.authenticateRequest(req).then(
            (ctx) => {
                const missing = requiredServerPermissions(method, path, req.body, options).filter(
                    (p) => !auth.hasPermission(ctx, p),
                );
                if (missing.length > 0) {
                    res.status(403).json({ error: `forbidden: missing permission ${missing.join(', ')}` });
                    return;
                }
                req.qcliServerAuth = ctx;
                next();
            },
            (err: { status?: number; message?: string }) => {
                if (typeof err?.status !== 'number') {
                    // not an auth error (e.g. a store failure): never expose its message
                    logger.error('authentication failed unexpectedly:', err);
                    res.status(500).json({ error: 'internal server error' });
                    return;
                }
                const status = err.status;
                res.status(status).json({ error: status === 401 ? err.message || 'unauthorized' : err.message || 'forbidden' });
            },
        );
    };
}
