import { CliStructuredOutput } from '../abstractions';
import { CliServerResponse } from '../models';
import { McpToolResult } from './mcp-types';

/** Renders command outputs as plain text (text as-is, tables `a | b`, lists one per line, json pretty, key-value `k: v`). */
export function renderOutputsAsText(outputs: readonly CliStructuredOutput[]): string {
    const blocks: string[] = [];
    for (const output of outputs ?? []) {
        switch (output?.type) {
            case 'text':
                blocks.push(output.value ?? '');
                break;
            case 'table':
                blocks.push([(output.headers ?? []).join(' | '), ...(output.rows ?? []).map((r) => (r ?? []).join(' | '))].join('\n'));
                break;
            case 'list':
                blocks.push((output.items ?? []).join('\n'));
                break;
            case 'json':
                blocks.push(JSON.stringify(output.value, null, 2) ?? 'null');
                break;
            case 'key-value':
                blocks.push((output.entries ?? []).map((e) => `${e.key}: ${e.value}`).join('\n'));
                break;
            default:
                blocks.push(JSON.stringify(output));
        }
    }
    return blocks.join('\n');
}

/** Tool result of a command response (`structured` when the outputs are exactly one json object). */
export function commandResult(response: CliServerResponse): McpToolResult {
    const outputs = response.outputs ?? [];
    const result: McpToolResult = { text: renderOutputsAsText(outputs), isError: response.exitCode !== 0 };
    if (outputs.length === 1 && outputs[0].type === 'json') {
        const value = outputs[0].value;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            result.structured = value as Record<string, unknown>;
        }
    }
    return result;
}

/** Renders rows (arrays or objects) as `a | b` lines under a header. */
export function renderRows(columns: string[] | null, rows: unknown[]): string {
    const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    let headers = columns ?? [];
    if (headers.length === 0 && rows.length > 0 && rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
        headers = Object.keys(rows[0] as Record<string, unknown>);
    }
    const lines = headers.length > 0 ? [headers.join(' | ')] : [];
    for (const row of rows) {
        if (Array.isArray(row)) {
            lines.push(row.map(cell).join(' | '));
        } else if (row && typeof row === 'object') {
            const obj = row as Record<string, unknown>;
            lines.push((headers.length > 0 ? headers : Object.keys(obj)).map((h) => cell(obj[h])).join(' | '));
        } else {
            lines.push(cell(row));
        }
    }
    return lines.join('\n');
}
