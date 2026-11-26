/**
 * System notifications: what the server tells its users and admins (an update is available, a restart is required,
 * a plugin failed to load or needs configuration, a security warning). The same contract on every platform; see
 * `docs/notifications-spec.md` of `@qodalis/cli-server-node`.
 *
 * A source publishes with `notify({ key, ... })`: the key names the condition, so publishing the same key again
 * updates the notification instead of adding one, and `resolve(key)` removes it once the condition ended (the update
 * was applied, the server restarted). Plugins publish through `context.notifications` (their entry) or
 * `builder.notifications` (code).
 */

/** How serious a notification is. */
export type CliNotificationSeverity = 'info' | 'warning' | 'error';

/** The severities, mildest first. */
export const CLI_NOTIFICATION_SEVERITIES: readonly CliNotificationSeverity[] = ['info', 'warning', 'error'];

/** What a source publishes. */
export interface CliNotificationInput {
    /**
     * Stable id of the condition (`update:server:weather`, `server.restart-required`): the same key updates the
     * notification, `resolve(key)` removes it. `[A-Za-z0-9._:@/+-]`, 1-200 characters.
     */
    key: string;
    /** What it is about, for filters and icons: `update`, `restart`, `plugin`, `security`, a plugin's own kind. */
    kind: string;
    severity: CliNotificationSeverity;
    /** One line (at most 200 characters). */
    title: string;
    /** Details (at most 2000 characters). */
    message: string;
    /** A dashboard path (`/plugins?tab=updates`) or an absolute http(s) URL the notification opens. */
    link?: string;
    /** Only users holding this permission see it (on a server without sign-in everyone sees everything). */
    requiredPermission?: string;
    /** Machine-readable details (at most 8 KB of JSON). */
    data?: Record<string, unknown>;
}

/** A notification as a user sees it. */
export interface CliNotification {
    /** Server-generated id (`n_<random>`), kept while the key lives. */
    id: string;
    key: string;
    kind: string;
    severity: CliNotificationSeverity;
    title: string;
    message: string;
    link?: string;
    requiredPermission?: string;
    data?: Record<string, unknown>;
    /** When the key was first published (ISO 8601 UTC). */
    createdAt: string;
    /** When its content last changed (ISO 8601 UTC): a change makes it unread again. */
    updatedAt: string;
    /** This user has read it. */
    read: boolean;
}

/** `GET /api/v1/qcli/notifications`. */
export interface CliNotificationList {
    items: CliNotification[];
    /** The user's unread notifications (all of them, whatever the filter). */
    unreadCount: number;
}

/** What `notification:changed` says happened. */
export type CliNotificationChange = 'created' | 'updated' | 'resolved' | 'read' | 'read-all' | 'dismissed' | 'cleared';

/** The server's notifications (`builder.notifications`, `context.notifications`). */
export interface ICliNotifications {
    /** Adds the notification, or updates the one with the same key (unread again when its content changed). */
    notify(input: CliNotificationInput): CliNotification;
    /** Removes the notification of a key whose condition ended; true when there was one. */
    resolve(key: string): boolean;
    /**
     * Removes the notifications whose key starts with `prefix` and is not in `keep`: a source that re-evaluates its
     * conditions (at startup, after a check) resolves what it no longer sees. Returns how many were removed.
     */
    resolveMissing(prefix: string, keep: Iterable<string>): number;
    /** The notification of a key (no per-user state), undefined when none. */
    get(key: string): Omit<CliNotification, 'read'> | undefined;
}

/** Published on the event bus (and the events socket) when a notification changes. */
export const CLI_NOTIFICATION_CHANGED_EVENT = 'notification:changed';
/** Clearing a notification for everyone (`DELETE /api/v1/qcli/notifications/{id}?scope=all`, `notifications clear --all`). */
export const CLI_NOTIFICATIONS_MANAGE_PERMISSION = 'notifications:manage';
/** Seeing the available updates and checking for them (`/api/v1/qcli/updates`). */
export const CLI_UPDATES_READ_PERMISSION = 'updates:read';

/** The keys and kinds of the server's own sources (the same on every platform). */
export const CliNotificationKeys = {
    /** Changes wait for a restart. */
    RestartRequired: 'server.restart-required',
    /** `allowAnonymousAdmin` is on. */
    AnonymousAdmin: 'security.anonymous-admin',
    /** `plugin.failed:<plugin name>`: a plugin failed to load at the last start. */
    PluginFailedPrefix: 'plugin.failed:',
    /** `plugin.needs-configuration:<plugin name>`: required settings without a value. */
    PluginNeedsConfigurationPrefix: 'plugin.needs-configuration:',
    /** `update:dashboard:<package>`, `update:server:<name>`, `update:code:<kind>:<package>`, `update:core:<package>`. */
    UpdatePrefix: 'update:',
} as const;

const KEY = /^[A-Za-z0-9._:@/+-]{1,200}$/;

/** True for a valid notification key. */
export function isCliNotificationKey(key: unknown): key is string {
    return typeof key === 'string' && KEY.test(key);
}

/**
 * Checks and normalizes an input (trimmed texts, defaults); throws an Error with the reason for an invalid one.
 */
export function normalizeCliNotificationInput(input: CliNotificationInput): CliNotificationInput {
    const i = (input ?? {}) as Partial<CliNotificationInput>;
    if (!isCliNotificationKey(i.key)) throw new Error('notification key must be 1-200 characters of [A-Za-z0-9._:@/+-]');
    const kind = typeof i.kind === 'string' ? i.kind.trim() : '';
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(kind)) throw new Error('notification kind must be 1-40 characters of [a-z0-9._-]');
    if (!CLI_NOTIFICATION_SEVERITIES.includes(i.severity as CliNotificationSeverity)) throw new Error('notification severity must be info, warning or error');
    const title = typeof i.title === 'string' ? i.title.trim() : '';
    if (!title || title.length > 200) throw new Error('notification title must be 1-200 characters');
    const message = typeof i.message === 'string' ? i.message.trim() : '';
    if (message.length > 2000) throw new Error('notification message must be at most 2000 characters');
    let link: string | undefined;
    if (i.link !== undefined && i.link !== null && i.link !== '') {
        if (typeof i.link !== 'string' || i.link.length > 2000 || !(/^\/(?!\/)/.test(i.link) || /^https?:\/\//i.test(i.link))) {
            throw new Error('notification link must be a path starting with / or an http(s) URL');
        }
        link = i.link;
    }
    let requiredPermission: string | undefined;
    if (i.requiredPermission !== undefined && i.requiredPermission !== null && i.requiredPermission !== '') {
        if (typeof i.requiredPermission !== 'string' || !/^[A-Za-z0-9_.*-]+:[A-Za-z0-9_.*-]+$/.test(i.requiredPermission)) {
            throw new Error('notification requiredPermission must be resource:action');
        }
        requiredPermission = i.requiredPermission;
    }
    let data: Record<string, unknown> | undefined;
    if (i.data !== undefined && i.data !== null) {
        if (typeof i.data !== 'object' || Array.isArray(i.data)) throw new Error('notification data must be an object');
        const json = JSON.stringify(i.data);
        if (json.length > 8192) throw new Error('notification data must be at most 8 KB of JSON');
        data = JSON.parse(json) as Record<string, unknown>;
    }
    return {
        key: i.key,
        kind,
        severity: i.severity as CliNotificationSeverity,
        title,
        message,
        ...(link ? { link } : {}),
        ...(requiredPermission ? { requiredPermission } : {}),
        ...(data ? { data } : {}),
    };
}

// ------------------------------------------------------------------------ updates

/** Where an update comes from and how it is applied. */
export type CliUpdateSource = 'marketplace' | 'code' | 'npm';

/** One package with a newer version (`GET /api/v1/qcli/updates`). */
export interface CliUpdateItem {
    /** `dashboard` plugin, `server` plugin, or the server's `core` package. */
    kind: 'dashboard' | 'server' | 'core';
    /** The marketplace name (`weather`, `@qodalis/cli-dashboard-module-tickets`) or the package. */
    name: string;
    /** The package of this server's platform. */
    package: string;
    title: string;
    icon?: string | null;
    /** The version running or installed; null when unknown. */
    current: string | null;
    /** The newest version this server can use; null when none. */
    latest: string | null;
    /** `marketplace`: installed from it (update here), `code`: added in the host's code, `npm`: the server package. */
    source: CliUpdateSource;
    /** A newer version exists. */
    updateAvailable: boolean;
    /** It can be updated from the dashboard or `admin ... update` (marketplace installs the policy allows). */
    canUpdate: boolean;
    /** Why it cannot be updated here (`update in code`, `unverified publisher`, ...). */
    reason?: string;
    /** The install command per platform (`{ node: 'npm install …@1.2.0' }`), for updates made in code. */
    install?: Record<string, string>;
}

/** `GET /api/v1/qcli/updates`: the update checker's last result. */
export interface CliUpdatesResult {
    /** When the last check finished (ISO 8601 UTC); null before the first. */
    checkedAt: string | null;
    /** A check is running. */
    checking: boolean;
    /** Why the last check failed, partly or fully (`marketplace unreachable`). */
    error?: string;
    /** The server package: always listed once checked, `updateAvailable` false when current. */
    server: CliUpdateItem | null;
    /** Dashboard plugins installed from the marketplace with a newer version. */
    dashboardPlugins: CliUpdateItem[];
    /** Server plugins installed from the marketplace with a newer version. */
    serverPlugins: CliUpdateItem[];
    /** Plugins (dashboard and server) the host adds in code whose package has a newer version: update them in code. */
    codePlugins: CliUpdateItem[];
    /** The updates available, all lists and the server together (the badge). */
    count: number;
}
