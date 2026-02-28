import { CliCommandProcessor } from '../abstractions/cli-command-processor';
import { CliCommandParameterDescriptor } from '../abstractions/cli-command-parameter-descriptor';
import { CliProcessCommand } from '../abstractions/cli-process-command';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';

class HttpGetProcessor extends CliCommandProcessor {
    command = 'get';
    description = 'Performs an HTTP GET request';
    parameters = [
        new CliCommandParameterDescriptor('headers', 'Show response headers', false, 'boolean'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const url = command.value;
        if (!url) return 'Usage: http get <url>';
        return doRequest(url, 'GET', undefined, 'headers' in (command.args ?? {}));
    }
}

class HttpPostProcessor extends CliCommandProcessor {
    command = 'post';
    description = 'Performs an HTTP POST request';
    parameters = [
        new CliCommandParameterDescriptor('body', 'Request body (JSON string)', false, 'string', ['-b']),
        new CliCommandParameterDescriptor('headers', 'Show response headers', false, 'boolean'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const url = command.value;
        if (!url) return "Usage: http post <url> --body '{\"key\":\"value\"}'";
        const body = command.args?.body as string | undefined;
        return doRequest(url, 'POST', body, 'headers' in (command.args ?? {}));
    }
}

async function doRequest(url: string, method: string, body?: string, showHeaders?: boolean): Promise<string> {
    try {
        const init: RequestInit = {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ?? undefined,
            signal: AbortSignal.timeout(30000),
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

export class CliHttpCommandProcessor extends CliCommandProcessor {
    command = 'http';
    description = 'Makes HTTP requests from the server';
    allowUnlistedCommands = false;
    processors: ICliCommandProcessor[] = [new HttpGetProcessor(), new HttpPostProcessor()];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return 'Usage: http get|post <url> [--body <json>] [--headers]';
    }
}
