import type { Server } from 'net';
import { Server as TlsServer } from 'tls';
import { Test } from 'supertest';

/**
 * supertest serves an app on `listen(0)`, the dual-stack wildcard `[::]`, but sends
 * its requests to `127.0.0.1:<port>`. On macOS another socket may bind
 * `127.0.0.1:<port>` at the same time (any test server listening on
 * `127.0.0.1:0`, in another worker, or another process), and the more specific
 * bind gets the requests: tests then saw other servers' answers (401/403 for a
 * 200/409), `socket hang up` or timeouts, a different test each run. Requests go
 * to the loopback of the family the server actually bound instead (`[::1]` for
 * `[::]`), which no IPv4 listener can take over.
 */
const TestClass = Test as unknown as {
    prototype: { serverAddress(app: Server, path: string): string; _server?: Server };
};

TestClass.prototype.serverAddress = function (this: { _server?: Server }, app: Server, path: string): string {
    if (!app.address()) this._server = app.listen(0);
    const { address, family, port } = app.address() as { address: string; family: string; port: number };
    const ipv6 = family === 'IPv6' || (family as unknown) === 6;
    const host = ipv6
        ? `[${address === '::' ? '::1' : address}]`
        : address === '0.0.0.0' ? '127.0.0.1' : address;
    const protocol = app instanceof TlsServer ? 'https' : 'http';
    return `${protocol}://${host}:${port}${path}`;
};
