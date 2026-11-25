import { CliStoredConfigProvider, formatCliConfigDuration, parseCliConfigDuration, type CliConfigValue } from '@qodalis/cli-server-abstractions';
import type { AuthService } from './services/auth-service';

/** The read-only facts the `users` provider shows. */
export interface UsersConfigFacts {
    protectServer: boolean;
    signIn: 'users' | 'external' | 'guard-only';
    allowNonExpiringTokens: boolean;
    apiTokensWithExternalAuth: boolean;
    usersReadOnly: boolean;
    groupsReadOnly: boolean;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * `users`: sessions, lockout and passwords, changeable at runtime (read on every sign-in,
 * request and password change); how the plugin protects the server is read-only.
 */
export function createUsersConfigProvider(auth: AuthService, facts: UsersConfigFacts): CliStoredConfigProvider {
    const initial = {
        sessionTimeout: formatCliConfigDuration(auth.sessionTimeoutMs),
        maxSessionLifetime: formatCliConfigDuration(auth.maxSessionLifetimeMs),
        maxLoginAttempts: auth.maxLoginAttempts,
        lockout: formatCliConfigDuration(auth.lockoutMs),
        minPasswordLength: auth.minPasswordLength,
    };
    const ms = (value: CliConfigValue, fallback: string) => parseCliConfigDuration(typeof value === 'string' ? value : fallback) ?? parseCliConfigDuration(fallback)!;
    const whole = (value: CliConfigValue) => (Number.isInteger(value) ? undefined : 'must be a whole number');
    const readOnly = (key: string, label: string, description: string, value: boolean | string) => ({
        key,
        label,
        description,
        type: typeof value === 'boolean' ? ('boolean' as const) : ('string' as const),
        mutable: false,
        requiresRestart: true,
        default: value,
    });
    return new CliStoredConfigProvider({
        id: 'users',
        title: 'Users',
        description: 'Sign-in sessions, lockout and passwords of the users plugin',
        order: 70,
        sections: [
            {
                id: 'sessions',
                title: 'Sessions',
                settings: [
                    {
                        key: 'sessionTimeout',
                        label: 'Idle timeout',
                        description: 'A session without activity for this long ends',
                        type: 'duration',
                        default: initial.sessionTimeout,
                        validation: { min: MINUTE, max: 30 * DAY },
                        apply: (value) => (auth.sessionTimeoutMs = ms(value, initial.sessionTimeout)),
                    },
                    {
                        key: 'maxSessionLifetime',
                        label: 'Maximum lifetime',
                        description: 'A session ends this long after sign-in, whatever its activity',
                        type: 'duration',
                        default: initial.maxSessionLifetime,
                        validation: { min: MINUTE, max: 365 * DAY },
                        apply: (value) => (auth.maxSessionLifetimeMs = ms(value, initial.maxSessionLifetime)),
                    },
                ],
            },
            {
                id: 'security',
                title: 'Lockout and passwords',
                settings: [
                    {
                        key: 'maxLoginAttempts',
                        label: 'Failed sign-ins before lockout',
                        description: 'Consecutive failures that lock an account',
                        type: 'number',
                        default: initial.maxLoginAttempts,
                        validation: { min: 1, max: 100 },
                        validate: whole,
                        apply: (value) => (auth.maxLoginAttempts = typeof value === 'number' ? value : initial.maxLoginAttempts),
                    },
                    {
                        key: 'lockout',
                        label: 'Lockout',
                        description: 'How long a locked account stays locked (also the window failures are counted in)',
                        type: 'duration',
                        default: initial.lockout,
                        validation: { min: 1000, max: DAY },
                        apply: (value) => (auth.lockoutMs = ms(value, initial.lockout)),
                    },
                    {
                        key: 'minPasswordLength',
                        label: 'Minimum password length',
                        description: 'Applies to new passwords',
                        type: 'number',
                        default: initial.minPasswordLength,
                        validation: { min: 1, max: 1024 },
                        validate: whole,
                        apply: (value) => (auth.minPasswordLength = typeof value === 'number' ? value : initial.minPasswordLength),
                    },
                ],
            },
            {
                id: 'access',
                title: 'Access',
                description: 'Set in code',
                settings: [
                    readOnly('protectServer', 'Protects the server', 'Every route and socket needs a users session', facts.protectServer),
                    readOnly('signIn', 'Sign-in', "users: the plugin's accounts; external: the host's auth adapter; guard-only: tokens only", facts.signIn),
                    readOnly('allowNonExpiringTokens', 'Non-expiring tokens', 'API tokens may never expire', facts.allowNonExpiringTokens),
                    readOnly('apiTokensWithExternalAuth', 'Tokens with external sign-in', "API tokens accepted beside the host's adapter", facts.apiTokensWithExternalAuth),
                    readOnly('usersReadOnly', 'Users managed by the host', 'User writes answer 501', facts.usersReadOnly),
                    readOnly('groupsReadOnly', 'Groups managed by the host', 'Group writes answer 501', facts.groupsReadOnly),
                ],
            },
        ],
    });
}
