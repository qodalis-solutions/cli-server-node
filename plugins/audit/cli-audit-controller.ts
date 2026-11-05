import { Router, Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import { ICliAuditStore } from '@qodalis/cli-server-abstractions';

/** Entries returned when the request names no limit. */
export const DEFAULT_AUDIT_LIMIT = 100;

/** The most entries one request returns, so a database store never loads the whole log. */
export const MAX_AUDIT_LIMIT = 1000;

/** The event recorded after the log was cleared. */
export const AUDIT_CLEARED_EVENT = 'audit_cleared';

/** Permissions of the audit API (enforced by the server's route policy on a protected server). */
export const AuditPermissions = {
    Read: 'audit:read',
    Clear: 'audit:clear',
} as const;

/**
 * Protects an audit route: returns the middleware that authenticates the request
 * and requires `permission` (the users plugin installs its own). Errors passed to
 * `next` carrying a `status` are answered `{ error }` with that status.
 */
export type CliAuditGuard = (permission: string) => RequestHandler[];

/** The caller identity the server's auth gate (or a guard) leaves on the request. */
interface RequestCaller {
    userId?: string;
    userName?: string;
    sessionId?: string;
}

function callerOf(req: Request): RequestCaller | undefined {
    return (req as Request & { qcliServerAuth?: RequestCaller }).qcliServerAuth;
}

/** Runs the current guard's middleware for `permission`, then the route. */
function guarded(permission: string, getGuard: () => CliAuditGuard | undefined): RequestHandler {
    return (req, res, next) => {
        const handlers = getGuard()?.(permission) ?? [];
        let index = 0;
        const step = (err?: unknown): void => {
            if (err !== undefined && err !== null) {
                next(err);
                return;
            }
            const handler = handlers[index++];
            if (!handler) {
                next();
                return;
            }
            try {
                handler(req, res, step as NextFunction);
            } catch (e) {
                next(e);
            }
        };
        step();
    };
}

class BadRequest extends Error {
    readonly status = 400;
}

/**
 * Parses an audit query time: epoch milliseconds or ISO 8601 (UTC when it names no
 * offset). Undefined when absent; a bad value answers 400.
 */
export function parseAuditTime(value: unknown, name: string): Date | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new BadRequest(`${name} must be an ISO 8601 date or epoch milliseconds`);
    const text = value.trim();
    let date: Date;
    if (/^-?\d+$/.test(text)) {
        date = new Date(Number(text));
    } else if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
        // `2026-11-05T10:00` has no offset: UTC, not the server's local time
        date = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text}Z` : text);
    } else {
        date = new Date(NaN);
    }
    if (Number.isNaN(date.getTime())) throw new BadRequest(`${name} must be an ISO 8601 date or epoch milliseconds`);
    return date;
}

/** Answers every error as `{ error }`: 4xx with its message, anything else a generic 500. */
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) return;
    const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
        res.status(status).json({ error: typeof err?.message === 'string' && err.message ? err.message : 'bad request' });
        return;
    }
    console.error('[audit] unhandled error:', err);
    res.status(500).json({ error: 'internal server error' });
};

/**
 * The audit log API, mounted at `/api/v1/qcli/audit`:
 * - `GET /?event=&username=&actor=&from=&to=&limit=&offset=`: entries newest first; the
 *   filters are exact and case-insensitive (`username` is the user an entry is about,
 *   `actor` who did it); `from`/`to` (ISO 8601, UTC without an offset, or epoch
 *   milliseconds) keep the entries with `from <= timestamp < to`; `limit` defaults to 100
 *   and is capped at 1000; a negative or non-integer `limit` or `offset`, or a bad time,
 *   answers 400 `{ error }`. Requires `audit:read` on a protected server.
 * - `DELETE /`: clears the log, then records `audit_cleared` with the caller as actor;
 *   204. Requires `audit:clear` on a protected server.
 *
 * @param store Where the log is kept.
 * @param getGuard Returns the guard protecting the routes, if any (read per request).
 */
export function createAuditController(store: ICliAuditStore, getGuard: () => CliAuditGuard | undefined = () => undefined): Router {
    const router = Router();

    const route = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next) => {
        fn(req, res).catch(next);
    };

    router.get('/', guarded(AuditPermissions.Read, getGuard), route(async (req, res) => {
        const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
        const count = (name: 'limit' | 'offset'): number | undefined => {
            const value = req.query[name];
            if (value === undefined || value === '') return undefined;
            if (typeof value !== 'string' || !/^\d+$/.test(value)) {
                throw new BadRequest('limit and offset must be integers >= 0');
            }
            return parseInt(value, 10);
        };
        const from = parseAuditTime(req.query.from, 'from');
        const to = parseAuditTime(req.query.to, 'to');
        const limit = Math.min(count('limit') ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
        const offset = count('offset');
        if (limit === 0) {
            res.json([]);
            return;
        }
        res.json(await store.getEntries({
            event: text(req.query.event),
            username: text(req.query.username),
            actor: text(req.query.actor),
            from,
            to,
            limit,
            offset,
        }));
    }));

    router.delete('/', guarded(AuditPermissions.Clear, getGuard), route(async (req, res) => {
        await store.clear();
        const caller = callerOf(req);
        const remoteAddress = req.ip ?? req.socket?.remoteAddress;
        await store.log({
            timestamp: Date.now(),
            event: AUDIT_CLEARED_EVENT,
            username: caller?.userName ?? '',
            ...(caller?.userId ? { userId: caller.userId } : {}),
            details: 'audit log cleared',
            ...(caller?.userName ? { actor: caller.userName } : {}),
            ...(caller?.userId ? { actorId: caller.userId } : {}),
            ...(remoteAddress || caller?.sessionId
                ? { metadata: { ...(remoteAddress ? { remoteAddress } : {}), ...(caller?.sessionId ? { sessionId: caller.sessionId } : {}) } }
                : {}),
        });
        res.status(204).end();
    }));

    router.use(errorHandler);
    return router;
}
