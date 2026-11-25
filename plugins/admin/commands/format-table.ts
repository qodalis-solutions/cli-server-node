/** Aligned columns: every column but the last padded to its widest cell. */
export function formatTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
    const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
    return [line(headers), ...rows.map(line)].join('\n');
}
