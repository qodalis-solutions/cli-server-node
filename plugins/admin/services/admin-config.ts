/**
 * Admin configuration — reads credentials and settings from environment variables.
 */
export interface AdminCredentials {
    username: string;
    password: string;
}

export interface ConfigEntry {
    key: string;
    value: string | number | boolean | string[];
    type: 'string' | 'number' | 'boolean' | 'string[]';
    description: string;
    mutable: boolean;
}

export interface ConfigSection {
    name: string;
    mutable: boolean;
    settings: ConfigEntry[];
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
        const customEntries: ConfigEntry[] = Object.entries(this._mutableSettings).map(
            ([key, val]) => ({
                key,
                value: val as string | number | boolean | string[],
                type: inferType(val),
                description: '',
                mutable: true,
            }),
        );

        return [
            {
                name: 'server',
                mutable: false,
                settings: [
                    { key: 'platform', value: 'node', type: 'string', description: 'Server platform', mutable: false },
                    { key: 'platformVersion', value: process.version, type: 'string', description: 'Node.js version', mutable: false },
                    { key: 'nodeEnv', value: process.env.NODE_ENV ?? 'development', type: 'string', description: 'NODE_ENV', mutable: false },
                    { key: 'pid', value: process.pid, type: 'number', description: 'Process ID', mutable: false },
                ],
            },
            {
                name: 'auth',
                mutable: false,
                settings: [
                    { key: 'username', value: this._username, type: 'string', description: 'Admin username', mutable: false },
                    { key: 'jwtSecretConfigured', value: !!this._jwtSecret || !!process.env.QCLI_ADMIN_JWT_SECRET, type: 'boolean', description: 'Whether JWT secret is explicitly set', mutable: false },
                ],
            },
            {
                name: 'custom',
                mutable: true,
                settings: customEntries,
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

function inferType(val: unknown): 'string' | 'number' | 'boolean' | 'string[]' {
    if (typeof val === 'boolean') return 'boolean';
    if (typeof val === 'number') return 'number';
    if (Array.isArray(val)) return 'string[]';
    return 'string';
}
