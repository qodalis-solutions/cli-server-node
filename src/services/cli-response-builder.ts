import { CliServerOutput } from '../models';
import { CliServerResponse } from '../models';

export interface ICliResponseBuilder {
    writeText(text: string, style?: 'success' | 'error' | 'info' | 'warning'): void;
    writeTable(headers: string[], rows: string[][]): void;
    writeList(items: string[], ordered?: boolean): void;
    writeJson(value: any): void;
    writeKeyValue(entries: Record<string, string>): void;
    setExitCode(code: number): void;
    build(): CliServerResponse;
}

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
