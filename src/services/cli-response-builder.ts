import { CliServerOutput } from '../models';
import { CliServerResponse } from '../models';

/** Fluent interface for building a structured CLI server response with typed output blocks. */
export interface ICliResponseBuilder {
    /** Appends a text output block with an optional style. */
    writeText(text: string, style?: 'success' | 'error' | 'info' | 'warning'): void;
    /** Appends a table output block. */
    writeTable(headers: string[], rows: string[][]): void;
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
