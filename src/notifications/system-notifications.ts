import { CliNotificationKeys, type CliRestartRequirement, type CliServerPluginState, type ICliNotifications } from '@qodalis/cli-server-abstractions';

/** The permission the server's own notifications need (the dashboard's audience). */
export const SYSTEM_NOTIFICATION_PERMISSION = 'admin:access';

/** "Restart required" while changes wait for a restart; resolved once none do (after every start). */
export function syncRestartNotification(notifications: ICliNotifications, pending: readonly CliRestartRequirement[]): void {
    if (pending.length === 0) {
        notifications.resolve(CliNotificationKeys.RestartRequired);
        return;
    }
    notifications.notify({
        key: CliNotificationKeys.RestartRequired,
        kind: 'restart',
        severity: 'warning',
        title: pending.length === 1 ? 'Restart required: 1 change waits for a restart' : `Restart required: ${pending.length} changes wait for a restart`,
        message: pending.map((p) => p.description || p.id).join('\n').slice(0, 2000),
        link: '/',
        requiredPermission: SYSTEM_NOTIFICATION_PERMISSION,
        data: { pending: pending.map((p) => p.id) },
    });
}

/** The security warning while `allowAnonymousAdmin` is on; resolved when it is off. */
export function syncAnonymousAdminNotification(notifications: ICliNotifications, on: boolean): void {
    if (!on) {
        notifications.resolve(CliNotificationKeys.AnonymousAdmin);
        return;
    }
    notifications.notify({
        key: CliNotificationKeys.AnonymousAdmin,
        kind: 'security',
        severity: 'warning',
        title: 'Anyone can administer this server',
        message:
            'allowAnonymousAdmin is on and no sign-in protects the server: anyone who can reach it can install plugins (code that runs in the server), change its configuration and restart it. Protect it with the users plugin, or turn allowAnonymousAdmin off.',
        link: '/config',
        requiredPermission: SYSTEM_NOTIFICATION_PERMISSION,
    });
}

/**
 * "Plugin failed to load" and "Plugin needs configuration" from what this start loaded; the notifications of plugins
 * that load now (or are gone) are resolved.
 */
export function syncPluginNotifications(notifications: ICliNotifications, states: readonly CliServerPluginState[]): void {
    const failed: string[] = [];
    const needs: string[] = [];
    for (const s of states) {
        const pluginPath = `/plugins/${encodeURIComponent(s.package)}`;
        if (s.status === 'failed') {
            const key = `${CliNotificationKeys.PluginFailedPrefix}${s.name}`;
            failed.push(key);
            notifications.notify({
                key,
                kind: 'plugin',
                severity: 'error',
                title: `Plugin ${s.name} failed to load`,
                message: `${s.package}@${s.version}: ${s.error ?? 'unknown error'}`.slice(0, 2000),
                link: pluginPath,
                requiredPermission: SYSTEM_NOTIFICATION_PERMISSION,
                data: { plugin: s.name, package: s.package, version: s.version, source: s.source, error: s.error ?? null },
            });
        } else if (s.status === 'needs-configuration') {
            const key = `${CliNotificationKeys.PluginNeedsConfigurationPrefix}${s.name}`;
            needs.push(key);
            const missing = s.missing ?? [];
            notifications.notify({
                key,
                kind: 'plugin',
                severity: 'warning',
                title: `Plugin ${s.name} needs configuration`,
                message: `Set ${missing.length ? missing.join(', ') : 'its required settings'}, then restart the server.`,
                link: `/config?${new URLSearchParams({ provider: s.settings ?? s.name })}`,
                requiredPermission: SYSTEM_NOTIFICATION_PERMISSION,
                data: { plugin: s.name, package: s.package, version: s.version, source: s.source, missing },
            });
        }
    }
    notifications.resolveMissing(CliNotificationKeys.PluginFailedPrefix, failed);
    notifications.resolveMissing(CliNotificationKeys.PluginNeedsConfigurationPrefix, needs);
}
