import type { CliServerAuthContext } from '../auth/cli-server-auth';
import { McpTool, McpToolProvider, mcpJson, mcpObjectSchema } from '../mcp/mcp-types';
import type { CliNotificationService, CliNotificationViewer } from './cli-notification-service';

/** `notifications_list`: the caller's notifications (read-only; marking them read stays a user's action). */
export class NotificationsMcpToolProvider implements McpToolProvider {
    readonly name = 'notifications';

    constructor(
        private readonly service: CliNotificationService,
        private readonly viewerOf: (auth: CliServerAuthContext | undefined) => CliNotificationViewer,
    ) {}

    getTools(): McpTool[] {
        return [
            {
                name: 'notifications_list',
                description:
                    "List the server's system notifications the caller may see (available updates, restart required, plugins that failed to load or need configuration, security warnings), newest first, with the unread count",
                inputSchema: mcpObjectSchema({
                    unread: { type: 'boolean', description: 'Only the unread ones' },
                    severity: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Only this severity' },
                    limit: { type: 'integer', minimum: 1, maximum: 500, description: 'At most this many (default 50)' },
                }),
                requiredPermissions: [],
                annotations: { readOnlyHint: true },
                call: async (args, context) => {
                    const result = this.service.list(this.viewerOf(context.auth), {
                        unread: args.unread === true,
                        severity: typeof args.severity === 'string' ? args.severity : undefined,
                        limit: typeof args.limit === 'number' ? args.limit : 50,
                    });
                    const text = result.items.length
                        ? result.items.map((n) => `${n.read ? ' ' : '*'} [${n.severity}] ${n.title}${n.message ? `: ${n.message}` : ''}`).join('\n')
                        : 'No notifications.';
                    return mcpJson({ ...result }, `${result.unreadCount} unread\n${text}`);
                },
            },
        ];
    }
}
