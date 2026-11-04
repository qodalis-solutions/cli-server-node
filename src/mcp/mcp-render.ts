import { CliStructuredOutput, CliTablePage } from '../abstractions';
import { CliServerResponse } from '../models';
import { McpToolResult } from './mcp-types';

/**
 * The line under a paged table: which rows these are (1-based) and the `skip` for the next ones,
 * e.g. `(rows 51-100 of 120; next: skip=100)`.
 * @param page - The table's page.
 * @param rowCount - The rows the table holds.
 */
export function describePage(page: CliTablePage, rowCount: number): string {
    const hasTotal = page.total !== undefined && page.total !== null;
    if (page.truncated === true) {
        return `(first ${rowCount}${hasTotal ? ` of ${page.total}` : ''} rows; the command does not page, narrow it down to see the rest)`;
    }
    const total = hasTotal ? ` of ${page.total}` : '';
    if (rowCount <= 0) {
        return `(no rows at skip=${page.skip}${total})`;
    }
    const next = page.hasMore ? `; next: skip=${page.skip + rowCount}` : '';
    return `(rows ${page.skip + 1}-${page.skip + rowCount}${total}${next})`;
}

/** Renders command outputs as plain text (text as-is, tables `a | b`, lists one per line, json pretty, key-value `k: v`). */
export function renderOutputsAsText(outputs: readonly CliStructuredOutput[]): string {
    const blocks: string[] = [];
    for (const output of outputs ?? []) {
        switch (output?.type) {
            case 'text':
                blocks.push(output.value ?? '');
                break;
            case 'table': {
                const lines = [(output.headers ?? []).join(' | '), ...(output.rows ?? []).map((r) => (r ?? []).join(' | '))];
                if (output.page) lines.push(describePage(output.page, output.rows?.length ?? 0));
                blocks.push(lines.join('\n'));
                break;
            }
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
