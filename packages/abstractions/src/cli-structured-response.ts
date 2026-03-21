export type CliStructuredOutput =
    | { type: 'text'; value: string; style?: 'success' | 'error' | 'info' | 'warning' }
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'list'; items: string[]; ordered?: boolean }
    | { type: 'json'; value: any }
    | { type: 'key-value'; entries: { key: string; value: string }[] };

export interface CliStructuredResponse {
    exitCode: number;
    outputs: CliStructuredOutput[];
}
