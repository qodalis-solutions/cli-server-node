import type { IncomingMessage } from 'http';
import * as os from 'os';
import { createHash, timingSafeEqual } from 'crypto';

/** How the remote shell decides who may open a session (`shellAuth` in `/capabilities`). */
export type CliShellAuthMode = 'users' | 'token' | 'custom' | 'anonymous' | 'locked';

/** Extra information handed to a custom {@link CliShellOptions.authorize} check. */
export interface CliShellAuthorizeContext {
    /** Parsed upgrade URL (path + query). */
    url: URL;
    /** Remote address of the socket. */
    remoteAddress: string;
    /** `interactive` shell or one-shot `command` (`?cmd=`). */
    mode: 'interactive' | 'command';
}

/** Environment of the shell child process. */
export interface CliShellEnvOptions {
    /** Extra server environment variable names copied into the shell (e.g. `['NODE_ENV']`). */
    allow?: string[];
    /** Fixed values set in the shell environment (applied last). */
    set?: Record<string, string>;
}

/**
 * Remote shell security options (`createCliServer({ enableShell: true, shell: {...} })`).
 *
 * The shell is only reachable when `enableShell` is true; access is then decided by
 * exactly one mode: `users` (users plugin mounted: ticket + `shell:execute`),
 * `token`, `custom` (`authorize`), or `anonymous` (`allowAnonymous`). With none of
 * them the shell is **locked** (every connection closed with 4401).
 */
export interface CliShellOptions {
    /**
     * Shared secret. Clients send `Authorization: Bearer <token>` (header, or the
     * `_header_Authorization` query parameter used by browser clients). Compared in
     * constant time, never logged. Always required when set (also with the users
     * plugin and together with `authorize`).
     */
    token?: string;
    /**
     * Host-defined check (headers, query, remote address). Thrown errors and
     * rejections deny. Always required when set (also with the users plugin and
     * together with `token`).
     */
    authorize?: (request: IncomingMessage, context: CliShellAuthorizeContext) => boolean | Promise<boolean>;
    /**
     * Open the shell to anyone who can reach the server (logs a startup WARNING).
     * Ignored once `token` or `authorize` is set.
     */
    allowAnonymous?: boolean;
    /** Concurrent shells per user (users mode) or per remote address (other modes). Default 3. */
    maxSessionsPerUser?: number;
    /** Concurrent shells in total. Default 20. */
    maxSessions?: number;
    /** Close a shell after this long without stdin (ms). Default 15 minutes; 0 disables. */
    idleTimeoutMs?: number;
    /** Close a shell after this long regardless of activity (ms). Default: no limit. */
    maxDurationMs?: number;
    /**
     * How often open users-mode shells re-check their session and `shell:execute` (ms).
     * Default 30 000, maximum 60 000. Session/user/group changes trigger an immediate re-check.
     */
    sessionCheckIntervalMs?: number;
    /** Working directory of the shell. Default: the server user's home directory. */
    cwd?: string;
    /** Shell binary. Default: detected (`$SHELL`, bash, sh; powershell on Windows). */
    shell?: string;
    /** Shell environment: a minimal base plus `allow` / `set`. */
    env?: CliShellEnvOptions;
}

export const SHELL_DEFAULTS = {
    maxSessionsPerUser: 3,
    maxSessions: 20,
    idleTimeoutMs: 15 * 60 * 1000,
    sessionCheckIntervalMs: 30 * 1000,
    maxSessionCheckIntervalMs: 60 * 1000,
    /** stdin touches the users session at most this often. */
    touchIntervalMs: 30 * 1000,
} as const;

/** WebSocket close codes used by the shell socket (accept, then close). */
export const ShellCloseCodes = {
    LoginRequired: 4401,
    Forbidden: 4403,
    Disabled: 4404,
    TimedOut: 4408,
    TooMany: 4429,
} as const;

/**
 * Resolves the access mode (`shellAuth`). Users plugin mounted ⇒ `users`; otherwise
 * `token` before `custom`, then `anonymous`; otherwise `locked`. Every configured
 * check among token/authorize must pass whatever the reported mode.
 */
export function resolveShellAuthMode(options: CliShellOptions | undefined, usersMounted: boolean): CliShellAuthMode {
    if (usersMounted) return 'users';
    if (options?.token) return 'token';
    if (options?.authorize) return 'custom';
    if (options?.allowAnonymous) return 'anonymous';
    return 'locked';
}

/** Constant-time comparison of a presented token with the configured secret. */
export function tokensEqual(presented: string, expected: string): boolean {
    const a = createHash('sha256').update(presented, 'utf8').digest();
    const b = createHash('sha256').update(expected, 'utf8').digest();
    return timingSafeEqual(a, b);
}

/**
 * Bearer token from the `Authorization` header or, for browser clients that
 * cannot set WebSocket headers, the `_header_Authorization` query parameter.
 */
export function readBearerToken(request: IncomingMessage, url: URL): string | undefined {
    let value: string | undefined = request.headers.authorization;
    if (!value) {
        for (const [key, v] of url.searchParams) {
            if (key.toLowerCase() === '_header_authorization') {
                value = v;
                break;
            }
        }
    }
    if (!value) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match ? match[1].trim() : undefined;
}

const BASE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'COLUMNS', 'LINES', 'SHELL'];
/** Variables Windows needs to start PowerShell at all. */
const WINDOWS_BASE_ENV = ['SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'TEMP', 'TMP'];

/**
 * Builds the minimal shell environment: `PATH`, `HOME`, `USER`, `LANG`, `TERM`,
 * `COLUMNS`, `LINES`, `SHELL` (plus the Windows essentials on win32), then the
 * `allow`-listed server variables, then the fixed `set` values.
 */
export function buildShellEnv(
    options: CliShellEnvOptions | undefined,
    info: { shell: string; cols: number; rows: number },
    source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const env: Record<string, string> = {};
    const names = os.platform() === 'win32' ? [...BASE_ENV, ...WINDOWS_BASE_ENV] : BASE_ENV;
    for (const name of [...names, ...(options?.allow ?? [])]) {
        const value = source[name];
        if (value !== undefined) env[name] = value;
    }
    env.TERM = 'xterm-256color';
    env.COLUMNS = String(info.cols);
    env.LINES = String(info.rows);
    env.SHELL = info.shell;
    if (!env.HOME) env.HOME = os.homedir();
    if (!env.USER) {
        try {
            env.USER = os.userInfo().username;
        } catch {
            // no passwd entry (containers with arbitrary uids)
        }
    }
    if (!env.PATH && os.platform() !== 'win32') {
        env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    }
    for (const [k, v] of Object.entries(options?.set ?? {})) {
        env[k] = String(v);
    }
    return env;
}
