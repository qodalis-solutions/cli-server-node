import { CliStoredConfigProvider, type CliConfigSection, type ICliConfigProvider } from '@qodalis/cli-server-abstractions';
import type { AdminConfig } from './admin-config';
import { LOG_BUFFER_MAX_CAPACITY, LOG_BUFFER_MIN_CAPACITY, LOG_LEVELS, type LogRingBuffer } from './log-ring-buffer';

/** How the dashboard signs users in. */
export type AdminSignInMode = 'password' | 'users' | 'external';

/**
 * `auth` (read-only): how the admin dashboard signs users in (today's admin `auth` section):
 * the mode, the static admin's username, whether the default credentials or an explicit JWT
 * secret are in use, and the host's sign-in URL. Never a password or the secret itself.
 */
export function createAdminAuthConfigProvider(config: AdminConfig, mode: () => AdminSignInMode, jwtSecretConfigured: () => boolean): ICliConfigProvider {
    return {
        id: 'auth',
        title: 'Authentication',
        description: 'How the admin dashboard signs users in (read-only)',
        order: 10,
        storage: { kind: 'options', description: "Read from the admin plugin's options", sources: [] },
        getSections(): CliConfigSection[] {
            const current = mode();
            return [
                {
                    id: 'admin',
                    title: 'Admin dashboard',
                    entries: [
                        {
                            key: 'mode',
                            label: 'Sign-in mode',
                            description: "password: the static admin credentials; users: the users plugin's accounts; external: the host application signs users in",
                            type: 'enum',
                            value: current,
                            validation: { options: ['password', 'users', 'external'] },
                        },
                        {
                            key: 'username',
                            label: 'Admin username',
                            description: 'The static admin (password mode)',
                            type: 'string',
                            value: config.username,
                            source: process.env.QCLI_ADMIN_USERNAME !== undefined ? 'environment' : 'default',
                        },
                        {
                            key: 'defaultCredentials',
                            label: 'Default credentials',
                            description: 'The well-known admin / admin credentials are in effect (password mode)',
                            type: 'boolean',
                            value: current === 'password' && config.usesDefaultCredentials(),
                        },
                        {
                            key: 'jwtSecretConfigured',
                            label: 'JWT secret set',
                            description: 'Whether JWT secret is explicitly set (otherwise random per start)',
                            type: 'boolean',
                            value: jwtSecretConfigured(),
                            source: process.env.QCLI_ADMIN_JWT_SECRET !== undefined ? 'environment' : 'default',
                        },
                        {
                            key: 'signInUrl',
                            label: 'Sign-in URL',
                            description: "Where the host application signs users in (external mode)",
                            type: 'string',
                            value: config.signInUrl ?? null,
                        },
                    ],
                },
            ];
        },
    };
}

/** `logs`: the admin log buffer (what the dashboard's Logs page and the logs socket show), changeable at runtime. */
export function createLogsConfigProvider(buffer: LogRingBuffer): CliStoredConfigProvider {
    const initial = { capacity: buffer.capacity, minLevel: buffer.minLevel };
    return new CliStoredConfigProvider({
        id: 'logs',
        title: 'Logs',
        description: 'The log buffer of the admin dashboard',
        order: 80,
        sections: [
            {
                id: 'buffer',
                title: 'Log buffer',
                settings: [
                    {
                        key: 'capacity',
                        label: 'Entries kept',
                        description: 'How many log entries the server keeps in memory (the newest)',
                        type: 'number',
                        default: initial.capacity,
                        validation: { min: LOG_BUFFER_MIN_CAPACITY, max: LOG_BUFFER_MAX_CAPACITY },
                        validate: (value) => (Number.isInteger(value) ? undefined : 'must be a whole number'),
                        apply: (value) => buffer.resize(typeof value === 'number' ? value : initial.capacity),
                    },
                    {
                        key: 'minLevel',
                        label: 'Lowest level',
                        description: 'Entries below this level are neither kept nor streamed',
                        type: 'enum',
                        default: initial.minLevel,
                        validation: { options: [...LOG_LEVELS] },
                        apply: (value) => {
                            buffer.minLevel = (typeof value === 'string' ? value : initial.minLevel) as typeof initial.minLevel;
                        },
                    },
                ],
            },
        ],
    });
}
