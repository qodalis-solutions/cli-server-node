import { timingSafeEqual, createHash } from 'crypto';

/**
 * Timing-safe string comparison. Hashes both strings with SHA-256
 * to normalize length, then uses timingSafeEqual.
 */
function safeCompare(a: string, b: string): boolean {
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
}

/** Admin username/password pair. */
export interface AdminCredentials {
    username: string;
    password: string;
}

/**
 * Manages the admin credentials, JWT secret and sign-in URL; reads the defaults from
 * environment variables on construction. The dashboard's settings are served by the config
 * providers (`auth` here, the server's built-in ones, and the plugins').
 */
export class AdminConfig {
    private _username: string;
    private _password: string;
    private _jwtSecret: string | undefined;
    private _signInUrl: string | undefined;

    /**
     * Where the host application signs users in, shown by the dashboard in external
     * sign-in mode (users plugin with an external auth adapter) and returned by
     * `GET /api/v1/qcli/auth/mode`. An absolute `http(s)` URL or a root-relative path
     * (`/sign-in`). Undefined: the dashboard tells users to sign in through the host application.
     *
     * The dashboard sends users back: it fills `{returnTo}` in the URL, or appends
     * `returnTo=`, with the dashboard page they were on (e.g. a terminal link's approval
     * page); after signing in, the host opens that URL with `#token=<bearer token>`.
     */
    get signInUrl(): string | undefined {
        return this._signInUrl;
    }

    set signInUrl(value: string | undefined) {
        this._signInUrl = value;
    }

    /** Validates the options set by the host. Throws on an invalid {@link signInUrl}. */
    validate(): void {
        if (this._signInUrl !== undefined && !AdminConfig.isValidSignInUrl(this._signInUrl)) {
            throw new Error(`signInUrl must be an absolute http(s) URL or a root-relative path, got '${this._signInUrl}'.`);
        }
    }

    /**
     * True for an absolute `http`/`https` URL with a host, or a root-relative path
     * (`/sign-in`; not protocol-relative `//host` or `/\host`). Rejects other schemes
     * such as `javascript:`, and control characters or whitespace.
     */
    static isValidSignInUrl(value: string | null | undefined): boolean {
        // eslint-disable-next-line no-control-regex
        if (typeof value !== 'string' || value.length === 0 || /[\s\x00-\x1f\x7f-\x9f]/.test(value)) {
            return false;
        }
        if (value.startsWith('/')) {
            return value.length === 1 || (value[1] !== '/' && value[1] !== '\\');
        }
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            return false;
        }
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
    }

    constructor() {
        this._username = process.env.QCLI_ADMIN_USERNAME ?? 'admin';
        this._password = process.env.QCLI_ADMIN_PASSWORD ?? 'admin';
        this._jwtSecret = process.env.QCLI_ADMIN_JWT_SECRET;
    }

    /** True while the well-known `admin` / `admin` credentials are in effect. */
    usesDefaultCredentials(): boolean {
        return this._username === 'admin' && this._password === 'admin';
    }

    /** Override the admin username and password. */
    setCredentials(username: string, password: string): void {
        this._username = username;
        this._password = password;
    }

    /** Set the JWT signing secret explicitly. */
    setJwtSecret(secret: string): void {
        this._jwtSecret = secret;
    }

    get jwtSecret(): string | undefined {
        return this._jwtSecret;
    }

    /** Validate credentials using timing-safe comparison. */
    validateCredentials(username: string, password: string): boolean {
        // Evaluate both comparisons to avoid short-circuit timing leaks
        const usernameMatch = safeCompare(username, this._username);
        const passwordMatch = safeCompare(password, this._password);
        return usernameMatch && passwordMatch;
    }

    /** The admin username (shown by the `auth` config provider). */
    get username(): string {
        return this._username;
    }
}
