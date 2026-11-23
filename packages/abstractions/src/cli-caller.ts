import { AsyncLocalStorage } from 'node:async_hooks';

/** The signed-in caller of a CLI request (the server's `CliServerAuthContext`). */
export interface CliCaller {
    userId: string;
    userName: string;
    /** Absent for host-authenticated (adapter) callers. */
    sessionId?: string;
    /** Set when the caller authenticated with an API token (no session). */
    tokenId?: string;
    /** Effective permissions (`resource:action`, `*` wildcards). */
    permissions: string[];
}

// One store per process, even when the server and a plugin load different copies of this package
const STORE_KEY = Symbol.for('qodalis.cli.caller');
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<CliCaller> | undefined>;
const callerStorage: AsyncLocalStorage<CliCaller> = (holder[STORE_KEY] ??= new AsyncLocalStorage<CliCaller>());

/**
 * The caller of the CLI request being handled, as the auth provider (e.g. the users plugin) authenticated it:
 * a session, an API token or the host's adapter. Lets plugin and host code, such as a processor, read the
 * signed-in user without a request object, e.g. to record who ran a command from the terminal.
 * `tokenId` is set when an API token signed the caller in, so code can refuse tokens for an operation.
 * Undefined outside an authenticated CLI request (an unprotected server, a background job).
 */
export function getCliCaller<T extends CliCaller = CliCaller>(): T | undefined {
    return callerStorage.getStore() as T | undefined;
}

/** Runs `fn` with `caller` as the CLI caller ({@link getCliCaller}); used by the server's auth gate. */
export function runAsCliCaller<R>(caller: CliCaller, fn: () => R): R {
    return callerStorage.run(caller, fn);
}
