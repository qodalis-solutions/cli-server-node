import { CliPageRequest } from '../abstractions';
import { CliServerOutput } from '../models';
import { CliServerResponse } from '../models';

/** Fluent interface for building a structured CLI server response with typed output blocks. */
export interface ICliResponseBuilder {
    /** Appends a text output block with an optional style. */
    writeText(text: string, style?: 'success' | 'error' | 'info' | 'warning'): void;
    /** Appends a table output block. */
    writeTable(headers: string[], rows: string[][]): void;
    /**
     * Appends some rows of a longer table. The terminal shows which rows they are under it and
     * the command for the next ones. Pass `total` when known; otherwise `hasMore` says whether
     * more rows follow (query one row more than `take` to find out).
     * @param headers - Column headers.
     * @param rows - The rows shown.
     * @param page - The rows that were asked for (`CliPaging.from(command)`).
     * @param options - `total`: all rows of the result, when known; `hasMore`: whether more rows
     * follow, defaulting to `page.skip + rows.length < total` (false without a total).
     */
    writePagedTable(
        headers: string[],
        rows: string[][],
        page: CliPageRequest,
        options?: { total?: number; hasMore?: boolean },
    ): void;
    /** Appends a list output block. */
    writeList(items: string[], ordered?: boolean): void;
    /** Appends a JSON output block. */
    writeJson(value: any): void;
    /** Appends a key-value pairs output block. */
    writeKeyValue(entries: Record<string, string>): void;
    /** Sets the exit code for the response. */
    setExitCode(code: number): void;
    /** Builds and returns the final structured response. */
    build(): CliServerResponse;
}

/** Default implementation of {@link ICliResponseBuilder} that accumulates output blocks. */
export class CliResponseBuilder implements ICliResponseBuilder {
    private _exitCode = 0;
    private _outputs: CliServerOutput[] = [];

    writeText(text: string, style?: 'success' | 'error' | 'info' | 'warning'): void {
        this._outputs.push({ type: 'text', value: text, ...(style ? { style } : {}) });
    }

    writeTable(headers: string[], rows: string[][]): void {
        this._outputs.push({ type: 'table', headers, rows });
    }

    writePagedTable(
        headers: string[],
        rows: string[][],
        page: CliPageRequest,
        options: { total?: number; hasMore?: boolean } = {},
    ): void {
        const { total } = options;
        const hasMore = options.hasMore ?? (total !== undefined && page.skip + rows.length < total);
        this._outputs.push({
            type: 'table',
            headers,
            rows,
            page: {
                skip: page.skip,
                take: page.take,
                ...(total !== undefined ? { total } : {}),
                hasMore,
            },
        });
    }

    writeList(items: string[], ordered = false): void {
        this._outputs.push({ type: 'list', items, ordered });
    }

    writeJson(value: any): void {
        this._outputs.push({ type: 'json', value });
    }

    writeKeyValue(entries: Record<string, string>): void {
        this._outputs.push({
            type: 'key-value',
            entries: Object.entries(entries).map(([key, value]) => ({ key, value })),
        });
    }

    setExitCode(code: number): void {
        this._exitCode = code;
    }

    build(): CliServerResponse {
        return {
            exitCode: this._exitCode,
            outputs: this._outputs,
        };
    }
}
