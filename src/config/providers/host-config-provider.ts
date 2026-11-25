import type { CliConfigEntry, CliConfigSection, CliConfigValue, ICliConfigProvider } from '@qodalis/cli-server-abstractions';

/** Which environment variables the `host` provider shows (`createCliServer({ config: { environment } })`). */
export interface CliHostEnvironmentOptions {
    /** Names to show; `*` matches any run of characters (default `['*']`: every variable). */
    include?: string[];
    /** Names to leave out, applied after `include` (default `['npm_*']`). */
    exclude?: string[];
    /** Further names whose values are secrets (masked), besides the built-in rule. */
    secrets?: string[];
}

/** A server option the `host` provider lists. */
export interface CliHostOption {
    key: string;
    label?: string;
    description?: string;
    value: CliConfigValue;
}

/**
 * Names treated as secrets: anything with SECRET, PASSWORD/PASSWD/PWD_, TOKEN, KEY (API_KEY, _KEY,
 * KEY_), PRIVATE, CREDENTIAL, AUTH, DSN, CONNECTION STRING, COOKIE, SALT, SIGNATURE or CERT in it.
 */
const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|PWD_|TOKEN|APIKEY|API_KEY|(^|_)KEY($|_)|PRIVATE|CREDENTIAL|AUTH|DSN|CONN(ECTION)?_?STR(ING)?|COOKIE|SALT|SIGNATURE|CERT)/i;

/** `scheme://user:password@host`: a URL carrying credentials. */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/i;

function globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
}

/** True when an environment variable holds a secret: by its name, a configured name, or a URL with credentials. */
export function isSecretEnvironmentVariable(name: string, value: string | undefined, extra: readonly string[] = []): boolean {
    if (SECRET_NAME.test(name)) return true;
    if (extra.some((pattern) => globToRegExp(pattern).test(name))) return true;
    return typeof value === 'string' && URL_WITH_CREDENTIALS.test(value);
}

/**
 * `host` (read-only): the host's configuration. Section `options`: the options the server was
 * created with; section `environment`: the process environment variables, secrets masked
 * (`value: null`, `isSet: true`; see {@link isSecretEnvironmentVariable}).
 */
export class CliHostConfigProvider implements ICliConfigProvider {
    readonly id = 'host';
    readonly title = 'Host';
    readonly description = 'Server options and environment variables (read-only, secrets masked)';
    readonly order = 20;
    private readonly include: RegExp[];
    private readonly exclude: RegExp[];
    private readonly secrets: string[];

    constructor(
        private readonly options: () => CliHostOption[],
        environment: CliHostEnvironmentOptions = {},
        private readonly env: NodeJS.ProcessEnv = process.env,
    ) {
        this.include = (environment.include ?? ['*']).map(globToRegExp);
        this.exclude = (environment.exclude ?? ['npm_*']).map(globToRegExp);
        this.secrets = environment.secrets ?? [];
    }

    getSections(): CliConfigSection[] {
        const environment: CliConfigEntry[] = Object.keys(this.env)
            .filter((name) => this.include.some((r) => r.test(name)) && !this.exclude.some((r) => r.test(name)))
            .sort((a, b) => a.localeCompare(b))
            .map((name) => {
                const value = this.env[name];
                const secret = isSecretEnvironmentVariable(name, value, this.secrets);
                return secret
                    ? { key: name, type: 'secret', value: null, isSet: !!value, sensitive: true, source: 'environment' }
                    : { key: name, type: 'string', value: value ?? '', source: 'environment' };
            });
        return [
            {
                id: 'options',
                title: 'Server options',
                description: 'The options the server was created with',
                entries: this.options().map((o) => ({
                    key: o.key,
                    ...(o.label ? { label: o.label } : {}),
                    ...(o.description ? { description: o.description } : {}),
                    type: Array.isArray(o.value) ? 'string[]' : typeof o.value === 'number' ? 'number' : typeof o.value === 'boolean' ? 'boolean' : 'string',
                    value: o.value,
                })),
            },
            { id: 'environment', title: 'Environment variables', description: 'Secrets are masked', entries: environment },
        ];
    }
}
