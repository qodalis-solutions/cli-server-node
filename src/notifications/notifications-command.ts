import {
    CLI_NOTIFICATIONS_MANAGE_PERMISSION,
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliProcessCommand,
    getPositionals,
    type CliNotification,
    type ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import type { CliNotificationService, CliNotificationViewer } from './cli-notification-service';

/** The viewer of the command's caller (the server decides: the signed-in user, or everyone on an open server). */
export type CliNotificationViewerResolver = () => CliNotificationViewer;

const SEVERITY_MARK: Record<string, string> = { info: 'i', warning: '!', error: 'x' };

function shortTime(iso: string): string {
    return iso.replace('T', ' ').slice(0, 16);
}

/** One notification as a line: `* ! 2026-11-26 10:00  Restart required  (n_ab12…)`. */
export function formatNotificationLine(n: CliNotification): string {
    return `${n.read ? ' ' : '*'} ${SEVERITY_MARK[n.severity] ?? ' '} ${shortTime(n.updatedAt)}  ${n.title}  (${n.id})`;
}

/** Finds a notification by its id or a unique id prefix (as listed). */
function findByIdOrPrefix(service: CliNotificationService, viewer: CliNotificationViewer, ref: string): CliNotification | string {
    const exact = service.find(viewer, ref);
    if (exact) return exact;
    const matches = service.list(viewer).items.filter((n) => n.id.startsWith(ref) || n.key === ref);
    if (matches.length === 1) return matches[0];
    return matches.length ? `Error: ${ref} matches ${matches.length} notifications; use the full id` : `Error: notification not found: ${ref}`;
}

class NotificationsListProcessor extends CliCommandProcessor {
    command = 'list';
    description = 'Lists your notifications, newest first (* unread)';
    parameters = [
        new CliCommandParameterDescriptor('unread', 'Only the unread ones', false, 'boolean'),
        new CliCommandParameterDescriptor('severity', 'Only info, warning or error', false, 'string'),
    ];

    constructor(
        private readonly service: CliNotificationService,
        private readonly viewer: CliNotificationViewerResolver,
    ) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const unread = command.args?.unread === true || command.args?.unread === 'true';
        const severity = typeof command.args?.severity === 'string' ? command.args.severity : undefined;
        const { items, unreadCount } = this.service.list(this.viewer(), { unread, severity });
        if (items.length === 0) return unread ? 'No unread notifications.' : 'No notifications.';
        const lines = [`${items.length} notification(s), ${unreadCount} unread`];
        for (const n of items) {
            lines.push(formatNotificationLine(n));
            if (n.message) lines.push(`      ${n.message.split('\n').join('\n      ')}`);
        }
        return lines.join('\n');
    }
}

class NotificationsReadProcessor extends CliCommandProcessor {
    command = 'read';
    description = 'Marks a notification read (notifications read <id>), or all of them (--all)';
    acceptsValue = true;
    parameters = [new CliCommandParameterDescriptor('all', 'Mark every notification read', false, 'boolean')];

    constructor(
        private readonly service: CliNotificationService,
        private readonly viewer: CliNotificationViewerResolver,
    ) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const viewer = this.viewer();
        if (command.args?.all === true || command.args?.all === 'true') {
            const marked = this.service.markAllRead(viewer);
            return `Marked ${marked} notification(s) read.`;
        }
        const [ref] = getPositionals(command);
        if (!ref) return 'Error: usage: notifications read <id> | notifications read --all';
        const found = findByIdOrPrefix(this.service, viewer, ref);
        if (typeof found === 'string') return found;
        this.service.markRead(viewer, found.id);
        return `Read: ${found.title}`;
    }
}

class NotificationsClearProcessor extends CliCommandProcessor {
    command = 'clear';
    description = `Dismisses a notification for you (notifications clear <id>); --all clears it for everyone (${CLI_NOTIFICATIONS_MANAGE_PERMISSION})`;
    acceptsValue = true;
    valueRequired = true;
    parameters = [new CliCommandParameterDescriptor('all', `Clear it for every user (${CLI_NOTIFICATIONS_MANAGE_PERMISSION})`, false, 'boolean')];

    constructor(
        private readonly service: CliNotificationService,
        private readonly viewer: CliNotificationViewerResolver,
    ) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const viewer = this.viewer();
        const [ref] = getPositionals(command);
        if (!ref) return 'Error: usage: notifications clear <id> [--all]';
        const all = command.args?.all === true || command.args?.all === 'true';
        if (all && !viewer.can(CLI_NOTIFICATIONS_MANAGE_PERMISSION)) return `Error: forbidden: missing permission ${CLI_NOTIFICATIONS_MANAGE_PERMISSION}`;
        const found = findByIdOrPrefix(this.service, viewer, ref);
        if (typeof found === 'string') return found;
        if (all) {
            this.service.clear(viewer, found.id);
            return `Cleared for everyone: ${found.title}`;
        }
        this.service.dismiss(viewer, found.id);
        return `Dismissed: ${found.title}`;
    }
}

/**
 * `notifications`: the caller's system notifications from the terminal. `list [--unread] [--severity s]`,
 * `read <id>|--all`, `clear <id> [--all]` (`--all` clears it for everyone and needs `notifications:manage`).
 * Ids may be shortened to a unique prefix.
 */
export class CliNotificationsCommandProcessor extends CliCommandProcessor {
    command = 'notifications';
    description = 'System notifications: updates, restarts, plugin problems, security warnings';
    module = 'notifications';
    icon = '🔔';
    processors: ICliCommandProcessor[];
    private readonly list: NotificationsListProcessor;

    constructor(service: CliNotificationService, viewer: CliNotificationViewerResolver) {
        super();
        this.list = new NotificationsListProcessor(service, viewer);
        this.processors = [this.list, new NotificationsReadProcessor(service, viewer), new NotificationsClearProcessor(service, viewer)];
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.list.handleAsync(command);
    }
}
