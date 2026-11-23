import { getCliCaller as getCaller, runAsCliCaller as runAs } from '@qodalis/cli-server-abstractions';
import type { CliServerAuthContext } from './cli-server-auth';

/**
 * The caller of the CLI request being handled, as the auth provider (e.g. the users plugin) authenticated it:
 * a session, an API token or the host's adapter. Lets host code, such as a processor's services, read the
 * signed-in user without a request object, e.g. for a host command run from a terminal linked with an API token.
 * `tokenId` is set when an API token signed the caller in, so host code can refuse tokens for an operation.
 * Undefined outside an authenticated CLI request (an unprotected server, a background job). Plugins read the
 * same caller with `getCliCaller` from `@qodalis/cli-server-abstractions`.
 */
export function getCliCaller(): CliServerAuthContext | undefined {
    return getCaller<CliServerAuthContext>();
}

/** Runs `fn` with `caller` as the CLI caller ({@link getCliCaller}); used by the server's auth gate. */
export function runAsCliCaller<T>(caller: CliServerAuthContext, fn: () => T): T {
    return runAs(caller, fn);
}
