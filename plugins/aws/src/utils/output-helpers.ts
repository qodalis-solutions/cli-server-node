import { CliProcessCommand, CliStructuredResponse, CliStructuredOutput } from '@qodalis/cli-server-abstractions';

/** Supported output format identifiers. */
export type OutputFormat = 'table' | 'json' | 'text';

/**
 * Extracts the output format from a command's `--output` argument.
 * @param command - The parsed CLI command.
 * @returns The requested output format, defaulting to `'table'`.
 */
export function getOutputFormat(command: CliProcessCommand): OutputFormat {
    const format = command.args?.output;
    if (format === 'json' || format === 'table' || format === 'text') return format;
    return 'table';
}

/**
 * Checks whether the `--dry-run` flag is set on a command.
 * @param command - The parsed CLI command.
 * @returns `true` if dry-run mode is enabled.
 */
export function isDryRun(command: CliProcessCommand): boolean {
    return command.args?.['dry-run'] === true || command.args?.dryRun === true;
}

/**
 * Builds a structured response with the given outputs and exit code.
 * @param outputs - The structured output items to include.
 * @param exitCode - Process exit code, defaults to 0.
 * @returns A CLI structured response.
 */
export function buildResponse(outputs: CliStructuredOutput[], exitCode = 0): CliStructuredResponse {
    return { exitCode, outputs };
}

/**
 * Builds an error response with exit code 1 and the given message.
 * @param message - The error message to display.
 * @returns A CLI structured response styled as an error.
 */
export function buildErrorResponse(message: string): CliStructuredResponse {
    return { exitCode: 1, outputs: [{ type: 'text', value: message, style: 'error' }] };
}

/**
 * Builds a success response with exit code 0 and the given message.
 * @param message - The success message to display.
 * @returns A CLI structured response styled as a success.
 */
export function buildSuccessResponse(message: string): CliStructuredResponse {
    return { exitCode: 0, outputs: [{ type: 'text', value: message, style: 'success' }] };
}

/**
 * Wraps arbitrary data as a JSON structured output.
 * @param data - The data to serialize as JSON.
 * @returns A CLI structured output of type `'json'`.
 */
export function formatAsJson(data: any): CliStructuredOutput {
    return { type: 'json', value: data };
}

/**
 * Formats tabular data with headers and rows.
 * @param headers - Column header labels.
 * @param rows - Two-dimensional array of cell values.
 * @returns A CLI structured output of type `'table'`.
 */
export function formatAsTable(headers: string[], rows: string[][]): CliStructuredOutput {
    return { type: 'table', headers, rows };
}

/**
 * Formats a record of key-value pairs for display.
 * @param entries - An object whose keys and values will be displayed.
 * @returns A CLI structured output of type `'key-value'`.
 */
export function formatAsKeyValue(entries: Record<string, string>): CliStructuredOutput {
    return { type: 'key-value', entries: Object.entries(entries).map(([key, value]) => ({ key, value })) };
}

/**
 * Formats an array of strings as a list output.
 * @param items - The list items to display.
 * @returns A CLI structured output of type `'list'`.
 */
export function formatAsList(items: string[]): CliStructuredOutput {
    return { type: 'list', items };
}

/**
 * Converts the default output to the format requested by the command's `--output` argument.
 * @param command - The parsed CLI command containing format preferences.
 * @param defaultOutput - The default structured output (typically a table or list).
 * @param rawData - The raw data to use when JSON format is requested.
 * @returns The structured output in the requested format.
 */
export function applyOutputFormat(command: CliProcessCommand, defaultOutput: CliStructuredOutput, rawData: any): CliStructuredOutput {
    const format = getOutputFormat(command);
    if (format === 'json') return formatAsJson(rawData);
    if (format === 'text' && defaultOutput.type === 'table') {
        const table = defaultOutput as { type: 'table'; headers: string[]; rows: string[][] };
        return { type: 'text', value: table.rows.map((row) => row.join('\t')).join('\n') };
    }
    return defaultOutput;
}
