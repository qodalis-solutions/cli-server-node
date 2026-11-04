import { Request, Response, NextFunction, RequestHandler } from 'express';

export const USERS_READ_ONLY_MESSAGE = 'Users are managed by the host application';
export const GROUPS_READ_ONLY_MESSAGE = 'Groups are managed by the host application';

export interface ReadOnlyStoresOptions {
    usersReadOnly: boolean;
    groupsReadOnly: boolean;
    /** Password changes then answer the external-auth 501 instead (the host owns credentials). */
    externalAuth: boolean;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function segments(req: Request): string[] {
    return req.path.split('/').filter((s) => s.length > 0);
}

/**
 * Which store a `/users` request writes to: create, update (self too), delete
 * and password set all write users.
 */
function usersRouteStore(req: Request, externalAuth: boolean): 'users' | undefined {
    const method = req.method.toUpperCase();
    const s = segments(req);
    if (s.length === 0 && method === 'POST') return 'users';
    if (s.length === 1 && (method === 'PUT' || method === 'DELETE')) return 'users';
    if (s.length === 2 && method === 'PUT' && s[1].toLowerCase() === 'password' && !externalAuth) return 'users';
    return undefined;
}

/**
 * Which store a `/groups` request writes to: create, update and delete write
 * groups; membership changes write the users (memberships live on the user).
 */
function groupsRouteStore(req: Request): 'users' | 'groups' | undefined {
    const method = req.method.toUpperCase();
    const s = segments(req);
    if (s.length === 0 && method === 'POST') return 'groups';
    if (s.length === 1 && (method === 'PUT' || method === 'DELETE')) return 'groups';
    if (s.length === 3 && s[1].toLowerCase() === 'members' && WRITES.has(method)) return 'users';
    return undefined;
}

/**
 * Answers 501 `{ error }` for writes to a read-only user or group store, before
 * authentication, body parsing or any store call (as the .NET server does).
 */
export function createReadOnlyStoresGuard(resource: 'users' | 'groups', options: ReadOnlyStoresOptions): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const store = resource === 'users' ? usersRouteStore(req, options.externalAuth) : groupsRouteStore(req);
        if (store === 'users' && options.usersReadOnly) {
            res.status(501).json({ error: USERS_READ_ONLY_MESSAGE });
            return;
        }
        if (store === 'groups' && options.groupsReadOnly) {
            res.status(501).json({ error: GROUPS_READ_ONLY_MESSAGE });
            return;
        }
        next();
    };
}
