import { Router, Request, Response } from 'express';
import { CLI_NOTIFICATIONS_MANAGE_PERMISSION, CLI_NOTIFICATION_SEVERITIES } from '@qodalis/cli-server-abstractions';
import type { CliNotificationService, CliNotificationViewer } from './cli-notification-service';

const MAX_LIMIT = 500;

/**
 * `/api/v1/qcli/notifications` (any signed-in user on a protected server; each sees the notifications whose
 * permission they hold):
 * - `GET /?unread=true&severity=&limit=` → `{ items, unreadCount }`, newest first;
 * - `POST /{id}/read` → the notification; `POST /read-all` → `{ marked, unreadCount }`;
 * - `DELETE /{id}` dismisses it for the caller; `DELETE /{id}?scope=all` clears it for everyone (`notifications:manage`).
 */
export function createNotificationsController(service: CliNotificationService, viewerOf: (req: Request) => CliNotificationViewer): Router {
    const router = Router();

    router.get('/', (req: Request, res: Response) => {
        const unread = req.query.unread === 'true' || req.query.unread === '1';
        const severity = typeof req.query.severity === 'string' && req.query.severity ? req.query.severity : undefined;
        if (severity && !CLI_NOTIFICATION_SEVERITIES.includes(severity as never)) {
            res.status(400).json({ error: `invalid severity: ${severity} (info, warning, error)` });
            return;
        }
        let limit: number | undefined;
        if (typeof req.query.limit === 'string' && req.query.limit) {
            limit = Number(req.query.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
                res.status(400).json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` });
                return;
            }
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(service.list(viewerOf(req), { unread, severity, limit }));
    });

    router.post('/read-all', (req: Request, res: Response) => {
        const viewer = viewerOf(req);
        const marked = service.markAllRead(viewer);
        res.json({ marked, unreadCount: service.unreadCount(viewer) });
    });

    router.post('/:id/read', (req: Request, res: Response) => {
        const viewer = viewerOf(req);
        const item = service.markRead(viewer, req.params.id);
        if (!item) {
            res.status(404).json({ error: 'notification not found' });
            return;
        }
        res.json({ item, unreadCount: service.unreadCount(viewer) });
    });

    router.delete('/:id', (req: Request, res: Response) => {
        const viewer = viewerOf(req);
        const all = req.query.scope === 'all';
        if (all && !viewer.can(CLI_NOTIFICATIONS_MANAGE_PERMISSION)) {
            res.status(403).json({ error: `forbidden: missing permission ${CLI_NOTIFICATIONS_MANAGE_PERMISSION}` });
            return;
        }
        const done = all ? service.clear(viewer, req.params.id) : service.dismiss(viewer, req.params.id);
        if (!done) {
            res.status(404).json({ error: 'notification not found' });
            return;
        }
        res.json({ [all ? 'cleared' : 'dismissed']: true, unreadCount: service.unreadCount(viewer) });
    });

    return router;
}
