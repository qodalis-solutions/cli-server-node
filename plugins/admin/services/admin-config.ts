/**
 * Admin configuration — reads credentials and settings from environment variables.
 */
export interface AdminCredentials {
    username: string;
    password: string;
}

export interface ConfigSection {
    key: string;
    label: string;
    description: string;
    values: Record<string, unknown>;
    mutable: boolean;
}

export class AdminConfig {
    private _username: string;
    private _password: string;
    private _jwtSecret: string | undefined;
    private readonly _mutableSettings: Record<string, unknown> = {};

    constructor() {
        this._username = process.env.QCLI_ADMIN_USERNAME ?? 'admin';
        this._password = process.env.QCLI_ADMIN_PASSWORD ?? 'admin';
        this._jwtSecret = process.env.QCLI_ADMIN_JWT_SECRET;
    }

    setCredentials(username: string, password: string): void {
        this._username = username;
        this._password = password;
    }

    setJwtSecret(secret: string): void {
        this._jwtSecret = secret;
    }

    get jwtSecret(): string | undefined {
        return this._jwtSecret;
    }

    validateCredentials(username: string, password: string): boolean {
        return username === this._username && password === this._password;
    }

    getConfigSections(): ConfigSection[] {
        return [
            {
                key: 'server',
                label: 'Server',
                description: 'Server runtime configuration',
                values: {
                    platform: 'node',
                    platformVersion: process.version,
                    nodeEnv: process.env.NODE_ENV ?? 'development',
                    pid: process.pid,
                },
                mutable: false,
            },
            {
                key: 'auth',
                label: 'Authentication',
                description: 'Admin authentication settings',
                values: {
                    username: this._username,
                    jwtSecretConfigured: !!this._jwtSecret || !!process.env.QCLI_ADMIN_JWT_SECRET,
                },
                mutable: false,
            },
            {
                key: 'custom',
                label: 'Custom Settings',
                description: 'User-defined mutable settings',
                values: { ...this._mutableSettings },
                mutable: true,
            },
        ];
    }

    getMutableSettings(): Record<string, unknown> {
        return { ...this._mutableSettings };
    }

    updateMutableSettings(values: Record<string, unknown>): void {
        Object.assign(this._mutableSettings, values);
    }
}
