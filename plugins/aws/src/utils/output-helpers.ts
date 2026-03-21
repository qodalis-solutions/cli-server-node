import { CliProcessCommand, CliStructuredResponse, CliStructuredOutput } from '@qodalis/cli-server-abstractions';

export type OutputFormat = 'table' | 'json' | 'text';

export function getOutputFormat(command: CliProcessCommand): OutputFormat {
    const format = command.args?.output;
    if (format === 'json' || format === 'table' || format === 'text') return format;
    return 'table';
}

export function isDryRun(command: CliProcessCommand): boolean {
    return command.args?.['dry-run'] === true || command.args?.dryRun === true;
}

export function buildResponse(outputs: CliStructuredOutput[], exitCode = 0): CliStructuredResponse {
    return { exitCode, outputs };
}

export function buildErrorResponse(message: string): CliStructuredResponse {
    return { exitCode: 1, outputs: [{ type: 'text', value: message, style: 'error' }] };
}

export function buildSuccessResponse(message: string): CliStructuredResponse {
    return { exitCode: 0, outputs: [{ type: 'text', value: message, style: 'success' }] };
}

export function formatAsJson(data: any): CliStructuredOutput {
    return { type: 'json', value: data };
}

export function formatAsTable(headers: string[], rows: string[][]): CliStructuredOutput {
    return { type: 'table', headers, rows };
}

export function formatAsKeyValue(entries: Record<string, string>): CliStructuredOutput {
    return { type: 'key-value', entries: Object.entries(entries).map(([key, value]) => ({ key, value })) };
}

export function formatAsList(items: string[]): CliStructuredOutput {
    return { type: 'list', items };
}

export function applyOutputFormat(command: CliProcessCommand, defaultOutput: CliStructuredOutput, rawData: any): CliStructuredOutput {
    const format = getOutputFormat(command);
    if (format === 'json') return formatAsJson(rawData);
    if (format === 'text' && defaultOutput.type === 'table') {
        const table = defaultOutput as { type: 'table'; headers: string[]; rows: string[][] };
        return { type: 'text', value: table.rows.map((row) => row.join('\t')).join('\n') };
    }
    return defaultOutput;
}
