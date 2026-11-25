/**
 * The entry point of the users plugin (`qodalis.entry`, `builder.addPlugin`): sign-in, users, groups, permissions,
 * sessions, API tokens and the audit log. It loads first (`CLI_PLUGIN_LOAD_ORDER.AUTH`) and the server holds
 * requests until it is loaded, so it protects every route and socket from the first request. Its stores are the
 * `users.stores` service when users-postgres loaded before it, else in memory. The setup is its settings (provider
 * `users-plugin`; sessions, lockout and passwords stay the `users` provider's); code options of other keys
 * (`authAdapter`, stores, `allowedOrigins`, ...) are the builder's `UsersModuleOptions`, read from code only.
 * Shared as the `users` service (the public-api plugin builds on it).
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliUsersBuilder } from './cli-users-builder';
import type { UsersModuleOptions } from './models';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'users', package: '@qodalis/cli-server-plugin-users', title: 'Users', icon: '👥' };

/** First: the sign-in protects what loads after it (`CLI_PLUGIN_LOAD_ORDER.AUTH`). */
export const order = 10;

/** The id of its settings provider (`users` is the provider of its sessions and passwords). */
export const SETTINGS_ID = 'users-plugin';

/** Its settings (code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'defaultAdminPassword', label: 'root password', description: "The seeded root user's password; empty: a random one, logged once", type: 'secret', requiresRestart: true },
    { key: 'protectServer', label: 'Protect the server', description: 'Every route and socket needs a sign-in', type: 'boolean', default: true, requiresRestart: true },
    { key: 'allowNonExpiringTokens', label: 'Tokens without expiry', description: 'API tokens may be created without an expiry date', type: 'boolean', default: false, requiresRestart: true },
    { key: 'linkApprovalUrl', label: 'Link approval page', description: "Where users approve a terminal's link request; empty: the dashboard's", type: 'string', default: '', requiresRestart: true, validation: { pattern: '^(|https?://\\S+|/(?![/\\\\])\\S*)$' } },
];

const SETTING_KEYS = new Set(settings.map((s) => s.key));

/** The stores users-postgres shares (`users.stores`). */
interface SharedUsersStores {
    userStore: UsersModuleOptions['userStore'];
    groupStore: UsersModuleOptions['groupStore'];
    credentialStore: UsersModuleOptions['credentialStore'];
    sessionStore: UsersModuleOptions['sessionStore'];
    apiTokenStore: UsersModuleOptions['apiTokenStore'];
    auditStore: UsersModuleOptions['auditStore'];
}

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({ id: SETTINGS_ID, title: 'Users (setup)', description: 'How the users plugin signs in and protects the server', settings });
    const value = (key: string) => provider.value('settings', key);
    const text = (key: string) => String(value(key) ?? '').trim();
    // The code's other options (adapters, stores, origins), then the stores shared by users-postgres, then the settings
    const codeOptions = Object.fromEntries(Object.entries(context.options).filter(([key]) => !SETTING_KEYS.has(key))) as UsersModuleOptions;
    const shared = context.services.get<SharedUsersStores>('users.stores');
    const builder = new CliUsersBuilder().setOptions({
        ...codeOptions,
        ...(shared && !codeOptions.userStore
            ? {
                  userStore: shared.userStore,
                  groupStore: shared.groupStore,
                  credentialStore: shared.credentialStore,
                  sessionStore: shared.sessionStore,
                  apiTokenStore: shared.apiTokenStore,
                  auditStore: shared.auditStore,
              }
            : {}),
        protectServer: value('protectServer') !== false,
        allowNonExpiringTokens: value('allowNonExpiringTokens') === true,
        ...(text('defaultAdminPassword') ? { defaultAdminPassword: text('defaultAdminPassword') } : {}),
        ...(text('linkApprovalUrl') ? { linkApprovalUrl: text('linkApprovalUrl') } : {}),
    });
    const users = builder.build(context.eventBus);
    await users.ready;
    context.services.set('users', users);
    return users;
}
