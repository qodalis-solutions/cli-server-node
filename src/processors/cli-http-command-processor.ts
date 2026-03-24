import { CliCommandProcessor } from '../abstractions/cli-command-processor';
import { CliCommandParameterDescriptor } from '../abstractions/cli-command-parameter-descriptor';
import { CliProcessCommand } from '../abstractions/cli-process-command';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';
import { ICliStreamCommandProcessor, CliStructuredOutput } from '../abstractions';

/** Sub-processor that performs HTTP GET requests. */
class HttpGetProcessor extends CliCommandProcessor implements ICliStreamCommandProcessor {
    command = 'get';
    description = 'Performs an HTTP GET request';
    parameters = [
        new CliCommandParameterDescriptor('headers', 'Show response headers', false, 'boolean'),
    ];

    async handleAsync(command: CliProcessCommand, signal?: AbortSignal): Promise<string> {
        const url = command.value;
        if (!url) return 'Usage: http get <url>';
        return doRequest(url, 'GET', undefined, 'headers' in (command.args ?? {}), signal);
    }

    async handleStreamAsync(
        command: CliProcessCommand,
        emit: (output: CliStructuredOutput) => void,
        signal?: AbortSignal,
    ): Promise<number> {
        const url = command.value;
        if (!url) {
            emit({ type: 'text', value: 'Usage: http get <url>' });
            return 1;
        }
        return doStreamRequest(url, 'GET', undefined, 'headers' in (command.args ?? {}), emit, signal);
    }
}

/** Sub-processor that performs HTTP POST requests. */
class HttpPostProcessor extends CliCommandProcessor implements ICliStreamCommandProcessor {
    command = 'post';
    description = 'Performs an HTTP POST request';
    parameters = [
        new CliCommandParameterDescriptor('body', 'Request body (JSON string)', false, 'string', ['-b']),
        new CliCommandParameterDescriptor('headers', 'Show response headers', false, 'boolean'),
    ];

    async handleAsync(command: CliProcessCommand, signal?: AbortSignal): Promise<string> {
        const url = command.value;
        if (!url) return "Usage: http post <url> --body '{\"key\":\"value\"}'";
        const body = command.args?.body as string | undefined;
        return doRequest(url, 'POST', body, 'headers' in (command.args ?? {}), signal);
    }

    async handleStreamAsync(
        command: CliProcessCommand,
        emit: (output: CliStructuredOutput) => void,
        signal?: AbortSignal,
    ): Promise<number> {
        const url = command.value;
        if (!url) {
            emit({ type: 'text', value: "Usage: http post <url> --body '{\"key\":\"value\"}'" });
            return 1;
        }
        const body = command.args?.body as string | undefined;
        return doStreamRequest(url, 'POST', body, 'headers' in (command.args ?? {}), emit, signal);
    }
}

/**
 * Executes an HTTP request and formats the response as a human-readable string.
 * @param url - Target URL.
 * @param method - HTTP method (GET, POST, etc.).
 * @param body - Optional JSON request body.
 * @param showHeaders - Whether to include response headers in output.
 * @returns Formatted response string (truncated to 5000 chars).
 */
async function doRequest(url: string, method: string, body?: string, showHeaders?: boolean, signal?: AbortSignal): Promise<string> {
    try {
        const timeoutSignal = AbortSignal.timeout(30000);
        const combinedSignal = signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal;

        const init: RequestInit = {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ?? undefined,
            signal: combinedSignal,
        };

        const resp = await fetch(url, init);
        const contentType = resp.headers.get('content-type') ?? 'unknown';
        let respBody = await resp.text();

        const lines: string[] = [
            `Status: ${resp.status}`,
            `Content-Type: ${contentType}`,
        ];

        if (showHeaders) {
            lines.push('Headers:');
            resp.headers.forEach((value, key) => {
                lines.push(`  ${key}: ${value}`);
            });
        }

        lines.push('');

        if (contentType.includes('json')) {
            try {
                respBody = JSON.stringify(JSON.parse(respBody), null, 2);
            } catch { /* keep raw */ }
        }

        lines.push(respBody.substring(0, 5000));
        return lines.join('\n');
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

/**
 * Executes an HTTP request and emits output incrementally via the `emit` callback.
 * @param url - Target URL.
 * @param method - HTTP method (GET, POST, etc.).
 * @param body - Optional JSON request body.
 * @param showHeaders - Whether to include response headers in output.
 * @param emit - Callback to send a single output chunk.
 * @returns Exit code (0 for success, 1 for error).
 */
async function doStreamRequest(
    url: string,
    method: string,
    body: string | undefined,
    showHeaders: boolean,
    emit: (output: CliStructuredOutput) => void,
    signal?: AbortSignal,
): Promise<number> {
    try {
        emit({ type: 'text', value: `Fetching ${method} ${url}...`, style: 'info' });

        const timeoutSignal = AbortSignal.timeout(30000);
        const combinedSignal = signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal;

        const init: RequestInit = {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ?? undefined,
            signal: combinedSignal,
        };

        const resp = await fetch(url, init);
        const contentType = resp.headers.get('content-type') ?? 'unknown';

        emit({ type: 'text', value: `Status: ${resp.status}` });
        emit({ type: 'text', value: `Content-Type: ${contentType}` });

        if (showHeaders) {
            emit({ type: 'text', value: 'Headers:' });
            resp.headers.forEach((value, key) => {
                emit({ type: 'text', value: `  ${key}: ${value}` });
            });
        }

        let respBody = await resp.text();
        if (contentType.includes('json')) {
            try {
                respBody = JSON.stringify(JSON.parse(respBody), null, 2);
            } catch { /* keep raw */ }
        }

        emit({ type: 'text', value: respBody.substring(0, 5000) });
        return 0;
    } catch (err: any) {
        emit({ type: 'text', value: `Error: ${err.message ?? err}`, style: 'error' });
        return 1;
    }
}

/** Command processor for server-side HTTP requests with `get` and `post` sub-commands. */
export class CliHttpCommandProcessor extends CliCommandProcessor {
    command = 'http';
    description = 'Makes HTTP requests from the server';
    allowUnlistedCommands = false;
    processors: ICliCommandProcessor[] = [new HttpGetProcessor(), new HttpPostProcessor()];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return 'Usage: http get|post <url> [--body <json>] [--headers]';
    }
}
